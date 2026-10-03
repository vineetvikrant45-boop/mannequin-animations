"""
Binary AndroidManifest.xml encoder (the format aapt2 produces).

The APK ships no application resources, so the manifest is the only
resource-shaped file: a UTF-8 string pool, a resource-id table that maps the
framework attribute names to their platform resource ids, and a flat tree of
start/end element chunks.
"""

import struct

RES_STRING_POOL_TYPE = 0x0001
RES_XML_TYPE = 0x0003
RES_XML_START_NAMESPACE_TYPE = 0x0100
RES_XML_END_NAMESPACE_TYPE = 0x0101
RES_XML_START_ELEMENT_TYPE = 0x0102
RES_XML_END_ELEMENT_TYPE = 0x0103
RES_XML_RESOURCE_MAP_TYPE = 0x0180

UTF8_FLAG = 1 << 8
NO_INDEX = 0xFFFFFFFF

ANDROID_NS = "http://schemas.android.com/apk/res/android"
NS_PREFIX = "android"

# framework attribute resource ids
ATTR = {
    "theme": 0x01010000,
    "label": 0x01010001,
    "icon": 0x01010002,
    "name": 0x01010003,
    "permission": 0x01010006,
    "debuggable": 0x0101000F,
    "exported": 0x01010010,
    "launchMode": 0x0101001D,
    "screenOrientation": 0x0101001E,
    "configChanges": 0x0101001F,
    "minSdkVersion": 0x0101020C,
    "versionCode": 0x0101021B,
    "versionName": 0x0101021C,
    "targetSdkVersion": 0x01010270,
    "maxSdkVersion": 0x01010271,
    "allowBackup": 0x01010280,
    "glEsVersion": 0x01010281,
    "required": 0x0101028E,
    "hardwareAccelerated": 0x010102D3,
    "usesCleartextTraffic": 0x010104EC,
}

TYPE_REFERENCE = 0x01
TYPE_STRING = 0x03
TYPE_INT_DEC = 0x10
TYPE_INT_HEX = 0x11
TYPE_INT_BOOLEAN = 0x12


# --------------------------------------------------------------- primitives

def _len_bytes(n: int) -> bytes:
    """Length prefix of a UTF-8 string pool entry (1 or 2 bytes).

    AOSP stores both the UTF-16 length and the byte length this way: if the high
    bit of the first byte is set, the value continues in the second byte.
    """
    if n > 0x7F:
        return bytes([((n >> 8) & 0x7F) | 0x80, n & 0xFF])
    return bytes([n])


class StringPool:
    def __init__(self, strings):
        self.strings = []
        self.index = {}
        for s in strings:
            self.add(s)

    def add(self, s):
        if s in self.index:
            return self.index[s]
        self.index[s] = len(self.strings)
        self.strings.append(s)
        return self.index[s]

    def contains(self, s):
        return s in self.index

    def encode(self) -> bytes:
        data = bytearray()
        offsets = []
        for s in self.strings:
            offsets.append(len(data))
            raw = s.encode("utf-8")
            data += _len_bytes(len(s.encode("utf-16-le")) // 2)
            data += _len_bytes(len(raw))
            data += raw
            data += b"\x00"
        while len(data) % 4:
            data.append(0)
        header_size = 28
        strings_start = header_size + 4 * len(self.strings)
        # AOSP stores the string offsets relative to the start of the string
        # data (not relative to the start of the chunk), which is also how
        # apktool/androguard read them back.
        body = b"".join(struct.pack("<I", o) for o in offsets) + bytes(data)
        chunk = bytearray()
        chunk += struct.pack("<HHI", RES_STRING_POOL_TYPE, header_size, 0)
        chunk += struct.pack("<IIIII", len(self.strings), 0, UTF8_FLAG, strings_start, 0)
        chunk += body
        chunk[4:8] = struct.pack("<I", len(chunk))
        return bytes(chunk)


class Attr:
    def __init__(self, name, value, type=None, ns=ANDROID_NS):
        self.name = name
        self.value = value
        self.ns = ns
        if type is None:
            if isinstance(value, bool):
                type = TYPE_INT_BOOLEAN
            elif isinstance(value, int):
                type = TYPE_INT_DEC
            else:
                type = TYPE_STRING
        self.type = type


class Element:
    def __init__(self, name, attrs=None, children=None):
        self.name = name
        self.attrs = attrs or []
        self.children = children or []


def _walk(el):
    yield el
    for c in el.children:
        yield from _walk(c)


def _chunk(type_, header_size, body: bytes) -> bytes:
    size = 8 + len(body)
    return struct.pack("<HHI", type_, header_size, size) + body


def build_manifest(manifest: Element) -> bytes:
    pool = StringPool([])
    pool.add(NS_PREFIX)
    pool.add(ANDROID_NS)
    for el in _walk(manifest):
        pool.add(el.name)
        for a in el.attrs:
            pool.add(a.name)
            if a.type == TYPE_STRING:
                pool.add(str(a.value))

    def emit(el: Element) -> bytes:
        attrs = bytearray()
        for a in el.attrs:
            raw_value = pool.index[str(a.value)] if a.type == TYPE_STRING else NO_INDEX
            attrs += struct.pack("<III", pool.index[a.ns], pool.index[a.name], raw_value)
            if a.type == TYPE_INT_BOOLEAN:
                data = 1 if a.value else 0
            elif a.type == TYPE_STRING:
                data = pool.index[str(a.value)]
            else:
                data = int(a.value) & 0xFFFFFFFF
            attrs += struct.pack("<HBBI", 8, 0, a.type, data)

        ext = struct.pack("<II", NO_INDEX, pool.index[el.name])
        ext += struct.pack("<HHHHHH", 20, 20, len(el.attrs), 0, 0, 0)
        out = bytearray()
        out += struct.pack("<HHI", RES_XML_START_ELEMENT_TYPE, 16, 16 + len(ext) + len(attrs))
        out += struct.pack("<II", 0, 0)                       # line number, comment
        out += ext
        out += attrs
        for c in el.children:
            out += emit(c)
        end = struct.pack("<II", 0, NO_INDEX)          # line number, comment
        end += struct.pack("<II", NO_INDEX, pool.index[el.name])
        out += _chunk(RES_XML_END_ELEMENT_TYPE, 16, end)
        return bytes(out)

    def ns_chunk(type_: int) -> bytes:
        # ResXMLTree_node header (16 bytes: chunk header + line number +
        # comment) followed by the prefix/uri string indices.
        node = struct.pack("<II", 0, NO_INDEX)
        node += struct.pack("<II", pool.index[NS_PREFIX], pool.index[ANDROID_NS])
        return _chunk(type_, 16, node)

    body = bytearray()
    body += ns_chunk(RES_XML_START_NAMESPACE_TYPE)
    body += emit(manifest)
    body += ns_chunk(RES_XML_END_NAMESPACE_TYPE)

    # resource map: one entry per string pool slot (0 when the string is not a
    # framework attribute name). This is what binds attribute names to the
    # platform resource ids Android looks them up by.
    res_ids = [ATTR.get(s, 0) for s in pool.strings]
    res_map_body = b"".join(struct.pack("<I", r) for r in res_ids)
    res_map = struct.pack("<HHI", RES_XML_RESOURCE_MAP_TYPE, 8, 8 + len(res_map_body)) + res_map_body

    pool_chunk = pool.encode()
    total = 8 + len(pool_chunk) + len(res_map) + len(body)
    return struct.pack("<HHI", RES_XML_TYPE, 8, total) + pool_chunk + res_map + bytes(body)
