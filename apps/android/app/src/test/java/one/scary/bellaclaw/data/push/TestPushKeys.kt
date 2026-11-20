package one.scary.bellaclaw.data.push

import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

fun base64Url(text: String): ByteArray = Base64.getUrlDecoder().decode(text)

fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

/** Device keys on a software P-256 key, as the Keystore would hold them. */
fun softwareKeys(privateKey: PrivateKey, publicKey: ByteArray, authSecret: ByteArray) =
    DeviceKeys(publicKey, authSecret) { peer -> ecdh(privateKey, peer) }

/** New software device keys. */
fun newSoftwareKeys(): DeviceKeys {
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    return softwareKeys(pair.private, uncompressed(pair.public as ECPublicKey), ByteArray(16).also { SecureRandom().nextBytes(it) })
}

/** The P-256 private key with scalar [d]. */
fun p256PrivateKey(d: ByteArray): PrivateKey {
    val parameters = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
    val spec = ECPrivateKeySpec(BigInteger(1, d), parameters.getParameterSpec(ECParameterSpec::class.java))
    return KeyFactory.getInstance("EC").generatePrivate(spec)
}

/** [plaintext] encrypted for [keys] the way the server's `encryptWebPush` does it, base64url. */
fun encryptLikeServer(plaintext: String, keys: DeviceKeys): String {
    val sender = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    val senderPublic = uncompressed(sender.public as ECPublicKey)
    val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
    val shared = ecdh(sender.private, p256PublicKey(keys.publicKey))
    val ikm = hkdf(keys.authSecret, shared, "WebPush: info\u0000".toByteArray() + keys.publicKey + senderPublic, 32)
    val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\u0000".toByteArray(), 16)
    val nonce = hkdf(salt, ikm, "Content-Encoding: nonce\u0000".toByteArray(), 12)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
    val record = cipher.doFinal(plaintext.toByteArray() + byteArrayOf(2))
    val header = ByteBuffer.allocate(5).putInt(4096).put(senderPublic.size.toByte()).array()
    return base64Url(salt + header + senderPublic + record)
}

private fun ecdh(privateKey: PrivateKey, peer: java.security.PublicKey): ByteArray {
    val agreement = KeyAgreement.getInstance("ECDH")
    agreement.init(privateKey)
    agreement.doPhase(peer, true)
    return agreement.generateSecret()
}

private fun uncompressed(key: ECPublicKey): ByteArray {
    fun coordinate(value: BigInteger): ByteArray {
        val bytes = value.toByteArray().takeLast(32).toByteArray()
        return ByteArray(32 - bytes.size) + bytes
    }
    return byteArrayOf(4) + coordinate(key.w.affineX) + coordinate(key.w.affineY)
}

private fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, bytes: Int): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(salt, "HmacSHA256"))
    val prk = mac.doFinal(ikm)
    mac.init(SecretKeySpec(prk, "HmacSHA256"))
    return mac.doFinal(info + byteArrayOf(1)).copyOf(bytes)
}
