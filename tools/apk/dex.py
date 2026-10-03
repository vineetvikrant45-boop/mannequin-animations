"""
Minimal Dalvik EXecutable (.dex) writer + assembler.

No d8/dx exists in this sandbox, so the tiny native wrapper of the game is
assembled straight into a valid dex file: one class, two methods, a couple of
dozen instructions. Follows the Dalvik executable format spec; the output is
verified by tools/apk/verify.py (androguard parses + disassembles it).
"""

import struct
import hashlib
import zlib

DEX_MAGIC = b"dex\n035\x00"
ENDIAN_CONSTANT = 0x12345678

ACC_PUBLIC = 0x0001
ACC_STATIC = 0x0008
ACC_CONSTRUCTOR = 0x10000

TYPE_HEADER_ITEM = 0x0000
TYPE_STRING_ID_ITEM = 0x0001
TYPE_TYPE_ID_ITEM = 0x0002
TYPE_PROTO_ID_ITEM = 0x0003
TYPE_METHOD_ID_ITEM = 0x0005
TYPE_CLASS_DEF_ITEM = 0x0006
TYPE_MAP_LIST = 0x1000
TYPE_TYPE_LIST = 0x1001
TYPE_CLASS_DATA_ITEM = 0x2000
TYPE_CODE_ITEM = 0x2001
TYPE_STRING_DATA_ITEM = 0x2002

INVOKE_OPCODES = {
    "virtual": 0x6E, "super": 0x6F, "direct": 0x70, "static": 0x71, "interface": 0x72
}


def uleb128(value: int) -> bytes:
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def mutf8(s: str) -> bytes:
    out = bytearray()
    for ch in s:
        code = ord(ch)
        if code == 0:
            out += b"\xc0\x80"
        elif code < 0x80:
            out.append(code)
        elif code < 0x800:
            out.append(0xC0 | (code >> 6))
            out.append(0x80 | (code & 0x3F))
        else:
            out.append(0xE0 | (code >> 12))
            out.append(0x80 | ((code >> 6) & 0x3F))
            out.append(0x80 | (code & 0x3F))
    return bytes(out)


def utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def shorty(ret: str, params) -> str:
    def one(t):
        return "L" if t.startswith("[") else t[0]
    return one(ret) + "".join(one(p) for p in params)


class Method:
    """A method reference plus (for our own class) its assembled body."""

    def __init__(self, cls, name, ret, params=(), access=ACC_PUBLIC, code=None,
                 registers=None, ins=None, direct=False):
        self.cls = cls
        self.name = name
        self.ret = ret
        self.params = tuple(params)
        self.access = access
        self.code = code or []
        self.registers = registers
        self.ins = ins
        self.direct = direct
        self.index = 0
        self.class_idx = 0
        self.proto_idx = 0
        self.name_idx = 0

    @property
    def proto(self):
        return (self.ret, self.params)


class DexBuilder:
    def __init__(self):
        self.methods = []
        self.classes = []          # (descriptor, superclass, source_file)

    def add_method(self, method: Method):
        self.methods.append(method)
        return method

    def add_class(self, descriptor, superclass, source_file):
        self.classes.append((descriptor, superclass, source_file))

    # -------------------------------------------------------------- layout
    def build(self) -> bytes:
        strings = set()
        for m in self.methods:
            strings.add(m.name)
            strings.add(m.cls)
            strings.add(m.ret)
            strings.update(m.params)
        for c in self.classes:
            strings.update(c)
        for m in self.methods:
            strings.add(shorty(m.ret, m.params))
            for op in m.code:                     # string literals
                if op[0] == "const-string":
                    strings.add(op[2])

        strings = sorted(strings)
        string_index = {s: i for i, s in enumerate(strings)}

        types = set()
        for m in self.methods:
            types.add(m.cls)
            types.add(m.ret)
            types.update(m.params)
        for c in self.classes:
            types.add(c[0])
            types.add(c[1])
        types = sorted(types, key=lambda t: (string_index[t], t))
        type_index = {t: i for i, t in enumerate(types)}

        protos = sorted({m.proto for m in self.methods},
                        key=lambda p: (type_index[p[0]], p[1]))
        proto_index = {p: i for i, p in enumerate(protos)}

        for m in self.methods:
            m.class_idx = type_index[m.cls]
            m.proto_idx = proto_index[m.proto]
            m.name_idx = string_index[m.name]
        ids = sorted(self.methods, key=lambda m: (m.class_idx, m.name_idx, m.proto_idx))
        for i, m in enumerate(ids):
            m.index = i
        self._prepare_lookups(string_index, type_index)

        # -------- data blobs
        string_data = [uleb128(utf16_len(s)) + mutf8(s) + b"\x00" for s in strings]

        type_list_blobs = []
        type_list_for_proto = {}
        for p in protos:
            if not p[1]:
                type_list_for_proto[p] = 0
            else:
                type_list_for_proto[p] = len(type_list_blobs)
                blob = struct.pack("<I", len(p[1]))
                blob += b"".join(struct.pack("<HH", type_index[t], 0) for t in p[1])
                type_list_blobs.append(blob)

        code_blobs = [self._encode_code(m) for m in ids if m.code]

        # -------- offsets
        header_size = 0x70
        off = header_size
        string_ids_off = off; off += 4 * len(strings)
        type_ids_off = off; off += 4 * len(types)
        proto_ids_off = off; off += 12 * len(protos)
        method_ids_off = off; off += 8 * len(ids)
        class_defs_off = off; off += 32 * len(self.classes)
        data_off = (off + 3) & ~3

        data = bytearray()

        def place(blob, align=4):
            while (data_off + len(data)) % align:
                data.append(0)
            start = data_off + len(data)
            data.extend(blob)
            return start

        string_data_offs = [place(b, 1) for b in string_data]
        type_list_offs = [place(b, 4) for b in type_list_blobs]

        code_offset_by_method = {}
        for m in ids:
            if not m.code:
                continue
            code_offset_by_method[id(m)] = place(code_blobs.pop(0), 4)

        class_data_offs = {}
        for descriptor, superclass, source in self.classes:
            direct = [m for m in ids if m.cls == descriptor and m.direct]
            virtual = [m for m in ids if m.cls == descriptor and not m.direct]
            blob = bytearray()
            blob += uleb128(0)                      # static fields
            blob += uleb128(0)                      # instance fields
            blob += uleb128(len(direct))
            blob += uleb128(len(virtual))
            for group in (direct, virtual):
                prev = 0
                for m in group:
                    blob += uleb128(m.index - prev)
                    prev = m.index
                    blob += uleb128(m.access)
                    blob += uleb128(code_offset_by_method.get(id(m), 0))
            class_data_offs[descriptor] = place(bytes(blob), 1)

        map_off = place(b"", 4)
        map_entries = [
            (TYPE_HEADER_ITEM, 1, 0),
            (TYPE_STRING_ID_ITEM, len(strings), string_ids_off),
            (TYPE_TYPE_ID_ITEM, len(types), type_ids_off),
            (TYPE_PROTO_ID_ITEM, len(protos), proto_ids_off),
            (TYPE_METHOD_ID_ITEM, len(ids), method_ids_off),
            (TYPE_CLASS_DEF_ITEM, len(self.classes), class_defs_off),
        ]
        if string_data:
            map_entries.append((TYPE_STRING_DATA_ITEM, len(string_data), string_data_offs[0]))
        if type_list_blobs:
            map_entries.append((TYPE_TYPE_LIST, len(type_list_blobs), type_list_offs[0]))
        if code_offset_by_method:
            first = min(place_ for place_ in code_offset_by_method.values())
            map_entries.append((TYPE_CODE_ITEM, len(code_offset_by_method), first))
        if class_data_offs:
            first = min(class_data_offs.values())
            map_entries.append((TYPE_CLASS_DATA_ITEM, len(class_data_offs), first))
        map_entries.append((TYPE_MAP_LIST, 1, map_off))
        map_entries.sort(key=lambda e: (e[2], e[0]))
        map_blob = struct.pack("<I", len(map_entries))
        map_blob += b"".join(struct.pack("<HHII", t, 0, size, o) for t, size, o in map_entries)
        data[map_off - data_off:] = map_blob

        # -------- fixed sections
        out = bytearray()
        out += DEX_MAGIC
        out += b"\x00" * 4
        out += b"\x00" * 20
        out += struct.pack("<I", 0)                     # file_size (patched later)
        out += struct.pack("<I", header_size)
        out += struct.pack("<I", ENDIAN_CONSTANT)
        out += struct.pack("<II", 0, 0)                 # link
        out += struct.pack("<I", map_off)
        out += struct.pack("<II", len(strings), string_ids_off)
        out += struct.pack("<II", len(types), type_ids_off)
        out += struct.pack("<II", len(protos), proto_ids_off)
        out += struct.pack("<II", 0, 0)                 # field ids
        out += struct.pack("<II", len(ids), method_ids_off)
        out += struct.pack("<II", len(self.classes), class_defs_off)
        out += struct.pack("<II", len(data), data_off)
        assert len(out) == header_size

        for o in string_data_offs:
            out += struct.pack("<I", o)
        for t in types:
            out += struct.pack("<I", string_index[t])
        for p in protos:
            # the proto's parameters_off points at the type_list blob in the
            # data section (0 when the method takes no arguments)
            blob = type_list_for_proto[p]
            params_off = type_list_offs[blob] if p[1] else 0
            out += struct.pack("<III", string_index[shorty(p[0], p[1])],
                               type_index[p[0]], params_off)
        for m in ids:
            out += struct.pack("<HHI", m.class_idx, m.proto_idx, m.name_idx)
        for descriptor, superclass, source in self.classes:
            out += struct.pack("<IIIIIIII",
                               type_index[descriptor], ACC_PUBLIC,
                               type_index[superclass], 0,
                               string_index[source], 0,
                               class_data_offs[descriptor], 0)
        while len(out) % 4:
            out.append(0)
        assert len(out) == data_off, (len(out), data_off)
        out += data

        out[32:36] = struct.pack("<I", len(out))
        out[12:32] = hashlib.sha1(bytes(out[32:])).digest()
        out[8:12] = struct.pack("<I", zlib.adler32(bytes(out[12:])) & 0xFFFFFFFF)
        return bytes(out)

    # --------------------------------------------------------- instructions
    def _encode_code(self, method: Method) -> bytes:
        insns, used = self._assemble(method)
        registers = method.registers if method.registers is not None else used
        ins = method.ins if method.ins is not None else 0
        outs = self._max_outs(method)
        # code items are 4-byte aligned, so a trailing nop is added when the
        # instruction list would leave the item size at 2 bytes mod 4 (what d8
        # does as well)
        if (16 + len(insns)) % 4:
            insns += b"\x00\x00"                         # nop
        body = struct.pack("<HHHHII", registers, ins, outs, 0, 0, len(insns) // 2)
        return body + insns

    def _max_outs(self, method: Method) -> int:
        n = 0
        for op in method.code:
            if op[0] == "invoke":
                n = max(n, len(op[2]))
        return max(n, 1)

    def _assemble(self, method: Method):
        u = bytearray()
        max_reg = 0
        for op in method.code:
            kind = op[0]
            if kind == "invoke":
                _, invoke_type, regs, target = op
                a = len(regs)
                c = regs[0] if a > 0 else 0
                d = regs[1] if a > 1 else 0
                e = regs[2] if a > 2 else 0
                f = regs[3] if a > 3 else 0
                g = regs[4] if a > 4 else 0
                assert a <= 5, "use invoke-range for >5 args"
                u += struct.pack("<HHH", INVOKE_OPCODES[invoke_type] | (g << 8) | (a << 12),
                                 target.index, c | (d << 4) | (e << 8) | (f << 12))
                max_reg = max(max_reg, max(regs) + 1 if regs else 0)
            elif kind == "new-instance":
                _, reg, type_desc = op
                u += struct.pack("<HH", 0x22 | (reg << 8), self._type_idx(type_desc))
                max_reg = max(max_reg, reg + 1)
            elif kind == "const-string":
                _, reg, value = op
                u += struct.pack("<HH", 0x1A | (reg << 8), self._string_idx(value))
                max_reg = max(max_reg, reg + 1)
            elif kind == "const/4":
                _, reg, value = op
                u += struct.pack("<H", 0x12 | (reg << 8) | ((value & 0xF) << 12))
                max_reg = max(max_reg, reg + 1)
            elif kind == "const/16":
                _, reg, value = op
                u += struct.pack("<Hh", 0x13 | (reg << 8), value)
                max_reg = max(max_reg, reg + 1)
            elif kind == "const":
                _, reg, value = op
                u += struct.pack("<HHH", 0x14 | (reg << 8), value & 0xFFFF, (value >> 16) & 0xFFFF)
                max_reg = max(max_reg, reg + 1)
            elif kind == "move-result-object":
                _, reg = op
                u += struct.pack("<H", 0x0C | (reg << 8))
                max_reg = max(max_reg, reg + 1)
            elif kind == "move-result":
                _, reg = op
                u += struct.pack("<H", 0x0A | (reg << 8))
                max_reg = max(max_reg, reg + 1)
            elif kind == "return-void":
                u += struct.pack("<H", 0x0E)
            elif kind == "nop":
                u += struct.pack("<H", 0x00)
            else:
                raise ValueError("unknown instruction: " + kind)
        return bytes(u), max(max_reg, 1)

    # index lookups are prepared by build(); kept as dicts for _assemble
    def _prepare_lookups(self, string_index, type_index):
        self._string_index = string_index
        self._type_index = type_index

    def _string_idx(self, s):
        return self._string_index[s]

    def _type_idx(self, t):
        return self._type_index[t]
