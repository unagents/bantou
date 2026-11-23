import assert from "node:assert/strict";
import { test } from "node:test";
import { CENTER_NAME_PREFIX, centerName, nameKey, readMachineId, type MachineIdSource } from "../src/center-name.js";

const linux = (files: Record<string, string>): MachineIdSource => ({
  platform: "linux",
  ioreg: () => {
    throw new Error("no ioreg");
  },
  readFile: (p) => {
    const v = files[p];
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  },
});

const IOREG = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 29>
  +-o J314sAP  <class IOPlatformExpertDevice, id 0x10000020f, registered, matched, active, busy 0 (46 ms), retain 40>
    {
      "IOPlatformSerialNumber" = "XXXX"
      "IOPlatformUUID" = "0123ABCD-0000-4000-8000-000000000000"
      "manufacturer" = "Apple Inc."
    }
`;

test("nameKey: sha256(\"bantou-name/v1:\" + 小文字・前後の空白を除いた機械の ID) の hex の先頭 10 桁", () => {
  assert.equal(nameKey("0123abcd-0000-4000-8000-000000000000"), "e4dadc1f0c");
  assert.equal(nameKey("  0123ABCD-0000-4000-8000-000000000000\n"), "e4dadc1f0c");
  assert.match(nameKey("x"), /^[0-9a-f]{10}$/);
  assert.notEqual(nameKey("x"), nameKey("y"));
});

test("Linux: /etc/machine-id、無ければ /var/lib/dbus/machine-id。空の物は飛ばす", () => {
  assert.equal(readMachineId(linux({ "/etc/machine-id": "abc123\n" })), "abc123");
  assert.equal(readMachineId(linux({ "/var/lib/dbus/machine-id": "dbus-id\n" })), "dbus-id");
  assert.equal(readMachineId(linux({ "/etc/machine-id": "\n", "/var/lib/dbus/machine-id": "dbus-id" })), "dbus-id");
  assert.equal(readMachineId(linux({ "/etc/machine-id": "first", "/var/lib/dbus/machine-id": "second" })), "first");
});

test("macOS: ioreg の IOPlatformUUID", () => {
  const src: MachineIdSource = { platform: "darwin", ioreg: () => IOREG, readFile: () => "unused" };
  assert.equal(readMachineId(src), "0123ABCD-0000-4000-8000-000000000000");
  assert.equal(centerName(src), `${CENTER_NAME_PREFIX}e4dadc1f0c`);
});

test("読めなければ投げる（起動しない）: Linux の 2 つの file が無い・空 / macOS の ioreg が失敗・UUID が無い", () => {
  assert.throws(() => readMachineId(linux({})), /機械の ID を読めない/);
  assert.throws(() => readMachineId(linux({ "/etc/machine-id": "  \n" })), /機械の ID を読めない/);
  assert.throws(() => centerName(linux({})), /機械の ID を読めない/);
  assert.throws(
    () =>
      readMachineId({
        platform: "darwin",
        ioreg: () => {
          throw new Error("spawn ioreg ENOENT");
        },
        readFile: () => "",
      }),
    /ioreg/,
  );
  assert.throws(() => readMachineId({ platform: "darwin", ioreg: () => "no uuid here", readFile: () => "" }), /IOPlatformUUID/);
});

test("centerName: bantou-center-<key>（prefix 無し）", () => {
  const n = centerName(linux({ "/etc/machine-id": "0123abcd-0000-4000-8000-000000000000" }));
  assert.equal(n, "bantou-center-e4dadc1f0c");
  assert.match(n, /^bantou-center-[0-9a-f]{10}$/);
});
