// NOTE: Web Push message encryption (RFC 8291) with the aes128gcm content coding (RFC 8188), as
// one record for one device, on the platform's WebCrypto
const RECORD_SIZE = 4096;
const encoder = new TextEncoder();

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    bytes * 8,
  );

  return new Uint8Array(bits);
}

// publicKey, authSecret: the device's P-256 public key (65 bytes uncompressed) and auth secret
// (16 bytes), base64url; sender: the application server's key pair, salt: 16 bytes, both new for
// every message. Returns the aes128gcm body: header, then the one record
export async function encryptWebPush(
  plaintext: Uint8Array<ArrayBuffer>,
  publicKey: string,
  authSecret: string,
  sender: CryptoKeyPair,
  salt: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const devicePublic = Buffer.from(publicKey, "base64url");
  const deviceKey = await crypto.subtle.importKey(
    "raw",
    devicePublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: deviceKey }, sender.privateKey, 256),
  );
  const ikm = await hkdf(
    Buffer.from(authSecret, "base64url"),
    shared,
    Buffer.concat([encoder.encode("WebPush: info\0"), devicePublic, senderPublic]),
    32,
  );
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02: the delimiter of the last record, with no padding after it
  const record = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    Buffer.concat([plaintext, Uint8Array.of(2)]),
  );
  const header = Buffer.alloc(5);
  header.writeUInt32BE(RECORD_SIZE, 0);
  header[4] = senderPublic.length;

  return Buffer.concat([salt, header, senderPublic, new Uint8Array(record)]);
}

// The plaintext encrypted for one device with a new key pair and salt, base64url
export async function encryptForDevice(
  plaintext: string,
  publicKey: string,
  authSecret: string,
): Promise<string> {
  const sender = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const body = await encryptWebPush(
    encoder.encode(plaintext),
    publicKey,
    authSecret,
    sender,
    crypto.getRandomValues(new Uint8Array(16)),
  );

  return Buffer.from(body).toString("base64url");
}
