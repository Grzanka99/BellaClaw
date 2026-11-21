package one.scary.bellaclaw.data.push

import java.security.PublicKey

/**
 * The device's RFC 8291 key material: [publicKey], the P-256 public key as 65 uncompressed bytes,
 * the 16-byte [authSecret], and [agree], the ECDH shared secret of the private key with a sender's key.
 */
class DeviceKeys(
    val publicKey: ByteArray,
    val authSecret: ByteArray,
    val agree: (PublicKey) -> ByteArray,
)
