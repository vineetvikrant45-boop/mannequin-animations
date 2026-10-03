#!/usr/bin/env python3
"""
Build an installable Android APK for Mannequin Playground.

This sandbox has no Android SDK (dl.google.com is unreachable), so the four
things aapt2/d8/apksigner would normally produce are generated directly:

  * AndroidManifest.xml — binary XML encoder      (tools/apk/binary_xml.py)
  * classes.dex         — Dalvik assembler        (tools/apk/dex.py)
  * no resources.arsc   — the app has zero resources (label/theme come from
                          framework resource ids referenced in the manifest)
  * signature           — JAR v1 + APK scheme v2  (tools/apk/sign.py)

Usage:
    python3 tools/apk_build.py [--out dist/MannequinPlayground.apk]
                               [--keystore tools/apk/keystore.pem]
"""

import argparse
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "apk"))

import binary_xml  # noqa: E402
import dex as dexmod  # noqa: E402
import sign as signmod  # noqa: E402

PKG = "com.mannequin.playground"
APP_NAME = "Mannequin Playground"


# --------------------------------------------------------------- manifest

def build_manifest() -> bytes:
    from binary_xml import Element, Attr, ANDROID_NS

    def a(name, value, type=None):
        return Attr(name, value, type=type, ns=ANDROID_NS)

    manifest = Element("manifest", [
        a("versionCode", 1),
        a("versionName", "1.0"),
        Attr("package", PKG),
    ], [
        Element("uses-sdk", [a("minSdkVersion", 21), a("targetSdkVersion", 33)]),
        Element("uses-permission", [a("name", "android.permission.VIBRATE")]),
        Element("uses-feature", [a("glEsVersion", 0x00020000, type=binary_xml.TYPE_INT_HEX),
                                 a("required", True)]),
        Element("application", [
            a("label", APP_NAME),
            # @android:style/Theme.Holo.NoActionBar.Fullscreen (AOSP public.xml
            # 0x0103006d): dark, no title/action bar, hides the status bar.
            a("theme", 0x0103006D, type=binary_xml.TYPE_REFERENCE),
            a("hardwareAccelerated", True),
            a("allowBackup", False),
            a("debuggable", False),
            a("usesCleartextTraffic", False),
        ], [
            Element("activity", [
                a("name", ".MainActivity"),
                a("exported", True),
                a("launchMode", 1),                                   # singleTop
                # locale|keyboard|keyboardHidden|navigation|orientation|
                # screenLayout|uiMode|screenSize|smallestScreenSize|density|
                # layoutDirection|fontScale  — the activity is never recreated
                a("configChanges", 0x40003FF4),
                a("screenOrientation", 6),                            # sensorLandscape
            ], [
                Element("intent-filter", [], [
                    Element("action", [a("name", "android.intent.action.MAIN")]),
                    Element("category", [a("name", "android.intent.category.LAUNCHER")]),
                ]),
            ]),
        ]),
    ])
    return binary_xml.build_manifest(manifest)


# -------------------------------------------------------------------- dex

def build_dex() -> bytes:
    b = dexmod.DexBuilder()
    cls = "Lcom/mannequin/playground/MainActivity;"
    activity = "Landroid/app/Activity;"
    bundle = "Landroid/os/Bundle;"
    webview = "Landroid/webkit/WebView;"
    settings = "Landroid/webkit/WebSettings;"
    view = "Landroid/view/View;"
    context = "Landroid/content/Context;"
    string = "Ljava/lang/String;"

    b.add_class(cls, activity, "MainActivity.java")

    # ---- framework method references
    ref_init_activity = b.add_method(dexmod.Method(activity, "<init>", "V"))
    ref_super_oncreate = b.add_method(dexmod.Method(activity, "onCreate", "V", (bundle,)))
    ref_set_content = b.add_method(dexmod.Method(activity, "setContentView", "V", (view,)))
    ref_webview_init = b.add_method(dexmod.Method(webview, "<init>", "V", (context,)))
    ref_get_settings = b.add_method(dexmod.Method(webview, "getSettings", settings))
    ref_load_url = b.add_method(dexmod.Method(webview, "loadUrl", "V", (string,)))
    ref_js = b.add_method(dexmod.Method(settings, "setJavaScriptEnabled", "V", ("Z",)))
    ref_dom = b.add_method(dexmod.Method(settings, "setDomStorageEnabled", "V", ("Z",)))
    ref_file = b.add_method(dexmod.Method(settings, "setAllowFileAccess", "V", ("Z",)))
    ref_bg = b.add_method(dexmod.Method(view, "setBackgroundColor", "V", ("I",)))
    ref_keep = b.add_method(dexmod.Method(view, "setKeepScreenOn", "V", ("Z",)))

    # ---- MainActivity.<init>()  — registers: v0 = this
    init_code = [
        ("invoke", "direct", (0,), ref_init_activity),
        ("return-void",),
    ]
    init_method = b.add_method(dexmod.Method(
        cls, "<init>", "V", (), access=dexmod.ACC_PUBLIC | dexmod.ACC_CONSTRUCTOR,
        code=init_code, registers=1, ins=1, direct=True))

    # ---- MainActivity.onCreate(Bundle) — registers v0..v3 locals, v4=this, v5=bundle
    oncreate_code = [
        ("invoke", "super", (4, 5), ref_super_oncreate),
        ("new-instance", 0, webview),
        ("invoke", "direct", (0, 4), ref_webview_init),
        ("invoke", "virtual", (0,), ref_get_settings),
        ("move-result-object", 1),
        ("const/4", 2, 1),
        ("invoke", "virtual", (1, 2), ref_js),
        ("invoke", "virtual", (1, 2), ref_dom),
        ("invoke", "virtual", (1, 2), ref_file),
        ("const", 2, 0xFF0B1020),
        ("invoke", "virtual", (0, 2), ref_bg),
        ("const/4", 2, 1),
        ("invoke", "virtual", (0, 2), ref_keep),
        ("const-string", 2, "file:///android_asset/index.html"),
        ("invoke", "virtual", (0, 2), ref_load_url),
        ("invoke", "virtual", (4, 0), ref_set_content),
        ("return-void",),
    ]
    b.add_method(dexmod.Method(
        cls, "onCreate", "V", (bundle,), access=dexmod.ACC_PUBLIC,
        code=oncreate_code, registers=6, ins=2))

    return b.build()


# ------------------------------------------------------------------ assets

def collect_assets(www_dir: str):
    assets = []
    for dirpath, _dirnames, filenames in os.walk(www_dir):
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, www_dir).replace(os.sep, "/")
            with open(full, "rb") as f:
                assets.append((f"assets/{rel}", f.read()))
    return sorted(assets)


# ------------------------------------------------------------------- build

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "MannequinPlayground.apk"))
    ap.add_argument("--www", default=os.path.join(ROOT, "game", "www"))
    ap.add_argument("--keystore", default=os.path.join(HERE, "apk", "mannequin-release.pem"))
    ap.add_argument("--skip-build", action="store_true", help="do not run the web build first")
    args = ap.parse_args()

    if not args.skip_build:
        print("• building the web bundle…")
        subprocess.run(["node", "build.mjs", "--inline"],
                       cwd=os.path.join(ROOT, "game"), check=True)

    if not os.path.isdir(args.www):
        sys.exit(f"missing {args.www}; run `npm run build` in game/ first")

    print("• encoding AndroidManifest.xml…")
    manifest = build_manifest()

    print("• assembling classes.dex…")
    dex = build_dex()

    print("• collecting assets…")
    assets = collect_assets(args.www)
    for name, data in assets:
        print(f"    {name}  {len(data) / 1024:.0f} KB")

    # signer: reuse an existing key so upgrades keep working
    from cryptography.hazmat.primitives import serialization
    if os.path.exists(args.keystore):
        with open(args.keystore, "rb") as f:
            key = serialization.load_pem_private_key(f.read(), password=None)
        cert_path = args.keystore.replace(".pem", ".crt.pem")
        with open(cert_path, "rb") as f:
            from cryptography import x509
            cert = x509.load_pem_x509_certificate(f.read())
        print(f"• reusing signing key {os.path.relpath(args.keystore, ROOT)}")
    else:
        print("• generating a signing key…")
        key, cert = signmod.generate_key()
        os.makedirs(os.path.dirname(args.keystore), exist_ok=True)
        with open(args.keystore, "wb") as f:
            f.write(key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption()))
        with open(args.keystore.replace(".pem", ".crt.pem"), "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))

    entries = [
        ("AndroidManifest.xml", manifest),
        ("classes.dex", dex),
    ] + assets

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    print("• packaging + signing (v1 + v2)…")
    t0 = time.time()
    signmod.write_apk(args.out, entries, key, cert)
    size = os.path.getsize(args.out)
    print(f"\n✔ {os.path.relpath(args.out, ROOT)}  ({size / 1024 / 1024:.2f} MB, "
          f"{time.time() - t0:.1f}s)")
    return args.out


if __name__ == "__main__":
    main()
