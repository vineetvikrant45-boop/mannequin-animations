#!/usr/bin/env python3
"""
Verify the generated APK without an Android device:

  * zip structure + entry list
  * binary AndroidManifest.xml decodes back to the XML we intended
  * classes.dex parses and MainActivity's bytecode disassembles to the
    instructions we assembled
  * the APK Signing Block (v2) digests and RSA signature verify
  * the JAR (v1) MANIFEST/CERT.SF digests verify

Usage: python3 tools/apk_verify.py [dist/MannequinPlayground.apk]
"""

import hashlib
import os
import re
import struct
import sys
import zipfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# androguard is chatty at DEBUG level
import logging  # noqa: E402
logging.getLogger("androguard").setLevel(logging.ERROR)

APK_SIG_BLOCK_MAGIC = b"APK Sig Block 42"
V2_BLOCK_ID = 0x7109871A

problems = []
checks = 0


def check(cond, label, detail=""):
    global checks
    checks += 1
    if cond:
        print(f"  \033[32m✓\033[0m {label}")
    else:
        print(f"  \033[31m✗\033[0m {label} {detail}")
        problems.append(label)


def verify_zip(path):
    print("\n[zip]")
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        check(bad is None, "archive integrity", bad)
        names = z.namelist()
        print("    entries:", ", ".join(names))
        check("AndroidManifest.xml" in names, "has AndroidManifest.xml")
        check("classes.dex" in names, "has classes.dex")
        check(any(n.startswith("assets/") for n in names), "has bundled assets")
        check(all(n.startswith(("META-INF/", "assets/")) or n in
                  ("AndroidManifest.xml", "classes.dex") for n in names),
              "no unexpected entries")
    return names


ANDROID_NS = "{http://schemas.android.com/apk/res/android}"


def verify_manifest(path):
    print("\n[AndroidManifest.xml]")
    from androguard.core.apk import APK
    apk = APK(path)
    xml = apk.get_android_manifest_xml()
    root = xml.getroot() if hasattr(xml, "getroot") else xml
    import lxml.etree as etree
    text = etree.tostring(root, pretty_print=True).decode()
    print("    " + text.strip().replace("\n", "\n    "))
    check(apk.get_package() == "com.mannequin.playground", "package name",
          apk.get_package())
    check(apk.get_min_sdk_version() == "21", "minSdk 21", apk.get_min_sdk_version())
    check(apk.get_target_sdk_version() == "33", "targetSdk 33", apk.get_target_sdk_version())
    check(apk.get_androidversion_name() == "1.0", "versionName")
    app_name = apk.get_app_name()
    check(app_name == "Mannequin Playground", "application label", app_name)
    acts = apk.get_activities()
    check("com.mannequin.playground.MainActivity" in acts, "launcher activity",
          ", ".join(acts))
    check("android.permission.VIBRATE" in apk.get_permissions(), "vibrate permission")

    app = root.find("application")
    check(app is not None, "application element")
    check(app.get(ANDROID_NS + "debuggable") in (None, "false"), "not debuggable",
          app.get(ANDROID_NS + "debuggable"))
    check(app.get(ANDROID_NS + "hardwareAccelerated") == "true", "hardware accelerated")
    theme = app.get(ANDROID_NS + "theme") or ""
    theme_id = int(re.sub(r"[^0-9a-fA-F]", "", theme.split("@android:")[-1]) or "0", 16)
    check(theme_id == 0x0103006D, "fullscreen theme Holo.NoActionBar.Fullscreen",
          theme)
    act = app.find("activity")
    check(act is not None and act.get(ANDROID_NS + "screenOrientation") == "6",
          "sensorLandscape orientation",
          act.get(ANDROID_NS + "screenOrientation") if act is not None else None)
    filt = act.find("intent-filter") if act is not None else None
    actions = [e.get(ANDROID_NS + "name") for e in (filt if filt is not None else [])]
    check("android.intent.action.MAIN" in actions and
          "android.intent.category.LAUNCHER" in actions,
          "MAIN/LAUNCHER intent filter", ", ".join(a or "?" for a in actions))
    feat = root.find("uses-feature")
    check(feat is not None and feat.get(ANDROID_NS + "glEsVersion") == "0x00020000",
          "requires OpenGL ES 2.0",
          feat.get(ANDROID_NS + "glEsVersion") if feat is not None else None)
    return apk


def verify_dex(path):
    print("\n[classes.dex]")
    from androguard.core.dex import DEX
    with zipfile.ZipFile(path) as z:
        raw = z.read("classes.dex")
    d = DEX(raw)
    classes = [c.get_name() for c in d.get_classes()]
    check("Lcom/mannequin/playground/MainActivity;" in classes, "MainActivity present",
          ", ".join(classes))
    target = [c for c in d.get_classes() if c.get_name() == "Lcom/mannequin/playground/MainActivity;"][0]
    methods = {m.get_name(): m for m in target.get_methods()}
    check("<init>" in methods, "constructor present")
    check("onCreate" in methods, "onCreate present")
    print("    disassembly of onCreate:")
    ops = []
    for ins in methods["onCreate"].get_instructions():
        ops.append(ins.get_name())
        print("      " + str(ins))
    expect = ["invoke-super", "new-instance", "invoke-direct", "invoke-virtual",
              "move-result-object", "const/4", "const-string", "return-void"]
    check(all(any(o.startswith(e) for o in ops) for e in expect),
          "onCreate contains the expected instructions", ", ".join(ops))
    strs = [i.get_output() for i in methods["onCreate"].get_instructions()
            if "const-string" in i.get_name()]
    check(any("file:///android_asset/index.html" in (s or "") for s in strs),
          "loads the bundled game page", str(strs))
    return d


def u16(buf, off):
    return struct.unpack("<H", buf[off:off + 2])[0]


def u32(buf, off):
    return struct.unpack("<I", buf[off:off + 4])[0]


def u64(buf, off):
    return struct.unpack("<Q", buf[off:off + 8])[0]


CHUNK_SIZE = 1024 * 1024


def content_digest(sections):
    """
    v2 content digest, re-implemented from
    android.util.apk.ApkSigningBlockUtils#computeContentDigestsPer1MbChunk:
    each section is cut into 1 MiB chunks, each chunk hashes as
    H(0xa5 || length || chunk) and the result is H(0x5a || chunkCount || chunk digests).
    """
    chunks = []
    for section in sections:
        for off in range(0, len(section), CHUNK_SIZE):
            chunk = section[off:off + CHUNK_SIZE]
            chunks.append(hashlib.sha256(
                b"\xa5" + struct.pack("<I", len(chunk)) + chunk).digest())
    top = hashlib.sha256()
    top.update(b"\x5a" + struct.pack("<I", len(chunks)))
    for c in chunks:
        top.update(c)
    return top.digest()


def lp(buf, off):
    """Length-prefixed slice: u32 length followed by that many bytes."""
    if off + 4 > len(buf):
        raise ValueError(f"no room for a length at {off} of {len(buf)}")
    n = u32(buf, off)
    if off + 4 + n > len(buf):
        raise ValueError(f"length {n} at {off} overruns {len(buf)}")
    return buf[off + 4:off + 4 + n], off + 4 + n


def verify_v2(path):
    print("\n[APK Signature Scheme v2]")
    with open(path, "rb") as f:
        data = f.read()
    problems_before = len(problems)

    # ---- APK Signing Block (ApkSigningBlockUtils.findApkSigningBlock)
    eocd_index = data.rfind(b"PK\x05\x06")
    eocd = data[eocd_index:]
    check(eocd_index + 22 == len(data), "EOCD is the last record")
    cd_offset = u32(eocd, 16)
    footer = data[cd_offset - 24:cd_offset]
    check(footer[8:24] == APK_SIG_BLOCK_MAGIC, "signing block footer magic",
          footer[8:24])
    size = u64(footer, 0)
    check(24 <= size <= 2 ** 31 - 9, "block size inside the platform's range", str(size))
    block_start = cd_offset - 8 - size
    check(block_start >= 0, "block starts after the ZIP entries")
    check(u64(data, block_start) == size, "header and footer sizes match")
    check((size + 8) % 4096 == 0, "block padded to a 4096-byte multiple", str(size + 8))

    # ---- id/value pairs
    pairs = []
    off = block_start + 8
    end = cd_offset - 24
    while off < end:
        plen = u64(data, off)
        pid = u32(data, off + 8)
        pairs.append((pid, data[off + 12:off + 8 + plen]))
        off += 8 + plen
    check(off == end, "pairs cover the block exactly", f"{off} vs {end}")
    check(any(pid == V2_BLOCK_ID for pid, _ in pairs), "v2 block present")
    extra = [hex(pid) for pid, _ in pairs if pid not in (V2_BLOCK_ID, 0x42726577)]
    check(not extra, "no unknown pairs besides the padding one", ", ".join(extra))
    value = dict(pairs)[V2_BLOCK_ID]

    # ---- v2 signer block, decoded the way ApkSignatureSchemeV2Verifier does
    try:
        signers, o = lp(value, 0)
        check(o == len(value), "v2 value holds exactly one signer sequence")

        signer, o = lp(signers, 0)
        check(o == len(signers), "exactly one signer", f"consumed {o}/{len(signers)}")

        signed_data, o = lp(signer, 0)
        signatures, o = lp(signer, o)
        public_key, o = lp(signer, o)
        check(o == len(signer), "signer block consumed exactly", f"{o}/{len(signer)}")

        # signatures: sequence of lp(u32 algorithm id | lp(signature))
        s_off = 0
        sig_records = []
        while s_off < len(signatures):
            rec, s_off = lp(signatures, s_off)
            alg = u32(rec, 0)
            sig, _ = lp(rec, 4)
            sig_records.append((alg, sig))
        check(len(sig_records) == 1, "one signature record", str(len(sig_records)))
        check(sig_records[0][0] == 0x0103,
              "signature algorithm RSASSA-PKCS1-v1_5 SHA-256", hex(sig_records[0][0]))

        # signed data: lp(digests) | lp(certificates) | lp(attributes)
        d_off = 0
        digests, d_off = lp(signed_data, d_off)
        certs, d_off = lp(signed_data, d_off)
        attrs, d_off = lp(signed_data, d_off)
        check(d_off == len(signed_data), "signed data consumed exactly",
              f"{d_off}/{len(signed_data)}")
        check(len(attrs) == 0, "no additional attributes")

        dig_off = 0
        digest_records = []
        while dig_off < len(digests):
            rec, dig_off = lp(digests, dig_off)
            alg = u32(rec, 0)
            digest, _ = lp(rec, 4)
            digest_records.append((alg, digest))
        check(len(digest_records) == 1, "one digest record", str(len(digest_records)))
        check(digest_records[0][0] == sig_records[0][0],
              "digest and signature algorithms agree")

        # ---- the digest the signer committed to must match the file.  For the
        # digest, the EOCD's "start of central directory" field counts as
        # pointing at the signing block (ApkSigningBlockUtils#verifyIntegrity).
        eocd_for_digest = bytearray(eocd)
        eocd_for_digest[16:20] = struct.pack("<I", block_start)
        want = content_digest([data[:block_start], data[cd_offset:eocd_index],
                               bytes(eocd_for_digest)])
        check(digest_records[0][1] == want, "content digest matches the APK")

        # ---- certificates
        c_off = 0
        cert_der, c_off = lp(certs, c_off)
        check(c_off == len(certs), "exactly one certificate")
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        cert = x509.load_der_x509_certificate(cert_der)
        check("CN=Mannequin Playground" in cert.subject.rfc4514_string(),
              "certificate subject", cert.subject.rfc4514_string())
        check(cert.not_valid_before_utc < datetime.now(timezone.utc) < cert.not_valid_after_utc,
              "certificate is inside its validity window")
        spki = cert.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        check(public_key == spki, "signer public key equals the certificate's")

        # ---- the RSA signature over the signed data
        try:
            cert.public_key().verify(sig_records[0][1], signed_data,
                                     padding.PKCS1v15(), hashes.SHA256())
            check(True, "RSA signature over the signed data verifies")
        except Exception as e:  # noqa: BLE001
            check(False, "RSA signature over the signed data verifies", str(e))
        check(len(problems) == problems_before, "v2 block decodes without surprises")
    except Exception as e:  # noqa: BLE001
        check(False, "v2 block decodes per the platform spec", f"{type(e).__name__}: {e}")


def verify_v1(path):
    print("\n[JAR signature (v1)]")
    import base64
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "META-INF/MANIFEST.MF" not in names:
            check(False, "MANIFEST.MF present")
            return
        manifest = z.read("META-INF/MANIFEST.MF")
        sf = z.read("META-INF/CERT.SF")
        text = manifest.decode()
        check("SHA-256-Digest" in text, "manifest carries per-entry digests")
        ok = True
        for line in text.split("\r\n\r\n"):
            m = re.match(r"Name: (.+)\r\nSHA-256-Digest: (.+)", line.strip())
            if not m:
                continue
            name, digest = m.group(1), m.group(2)
            actual = base64.b64encode(hashlib.sha256(z.read(name)).digest()).decode()
            if actual != digest:
                ok = False
                print("      mismatch:", name)
        check(ok, "every entry digest in MANIFEST.MF verifies")

        sf_text = sf.decode()
        m = re.search(r"SHA-256-Digest-Manifest: (.+)", sf_text)
        check(m is not None, "CERT.SF references the whole manifest")
        if m:
            actual = base64.b64encode(hashlib.sha256(manifest).digest()).decode()
            check(actual == m.group(1).strip(), "CERT.SF manifest digest verifies")

        p7 = z.read("META-INF/CERT.RSA")

    # ---- PKCS#7 SignedData, parsed by hand (cryptography only gives us certs)
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    def read_len(buf, off):
        first = buf[off]
        if not first & 0x80:
            return first, off + 1
        n = first & 0x7F
        return int.from_bytes(buf[off + 1:off + 1 + n], "big"), off + 1 + n

    def children(el):
        """Split a constructed DER element into its raw child elements."""
        length, off = read_len(el, 1)
        stop = off + length
        out = []
        while off < stop:
            child_len, body_off = read_len(el, off + 1)
            out.append(el[off:body_off + child_len])
            off = body_off + child_len
        return out

    try:
        # ContentInfo { OID signedData, [0] EXPLICIT SignedData }
        oid_el, explicit = children(p7)
        length, off = read_len(oid_el, 1)
        check(oid_el[off:off + length] == bytes.fromhex("2a864886f70d010702"),
              "CERT.RSA is a PKCS#7 signedData structure")
        signed_data = children(explicit)[0]
        fields = children(signed_data)
        certs_field = [f for f in fields if f[0] == 0xA0]
        check(len(certs_field) == 1, "SignedData carries a certificates set")
        certs = children(certs_field[0])
        check(len(certs) == 1, "one certificate in CERT.RSA")
        cert = x509.load_der_x509_certificate(certs[0])

        signer_info = children(children(fields[-1])[0])
        raw_sig = signer_info[-1]
        length, off = read_len(raw_sig, 1)
        sig_bytes = raw_sig[off:off + length]
        try:
            cert.public_key().verify(sig_bytes, sf, padding.PKCS1v15(), hashes.SHA256())
            check(True, "PKCS#7 signature over CERT.SF verifies")
        except Exception as e:  # noqa: BLE001
            check(False, "PKCS#7 signature over CERT.SF verifies", str(e))
        check("CN=Mannequin Playground" in cert.subject.rfc4514_string(),
              "CERT.RSA certificate subject", cert.subject.rfc4514_string())
    except Exception as e:  # noqa: BLE001
        check(False, "CERT.RSA parses as a PKCS#7 SignedData", f"{type(e).__name__}: {e}")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist", "MannequinPlayground.apk")
    print(f"verifying {path}  ({os.path.getsize(path) / 1024:.0f} KB)")
    verify_zip(path)
    verify_manifest(path)
    verify_dex(path)
    verify_v2(path)
    verify_v1(path)
    print(f"\n{checks - len(problems)}/{checks} checks passed")
    if problems:
        print("FAILED: " + "; ".join(problems))
        return 1
    print("APK looks installable.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
