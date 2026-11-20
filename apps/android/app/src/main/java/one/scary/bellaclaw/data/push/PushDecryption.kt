package one.scary.bellaclaw.data.push

import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import one.scary.bellaclaw.model.AppPush

private const val SALT_BYTES = 16
private const val HEADER_BYTES = SALT_BYTES + 5
private const val PUBLIC_KEY_BYTES = 65
private const val TAG_BYTES = 16
private const val LAST_RECORD_DELIMITER: Byte = 2

private val json = Json { ignoreUnknownKeys = true }

/** The push in [ciphertext] (the FCM data field, base64url), or null when it does not decrypt for [keys] or parse. */
fun decryptPush(ciphertext: String, keys: DeviceKeys): AppPush? {
    val plaintext = try {
        decryptWebPush(Base64.getUrlDecoder().decode(ciphertext), keys)
    } catch (_: IllegalArgumentException) {
        null
    } ?: return null
    return try {
        json.decodeFromString(PushBody.serializer(), plaintext.decodeToString()).toAppPush()
    } catch (_: IllegalArgumentException) {
        // SerializationException included.
        null
    }
}

/**
 * RFC 8291 decryption of an `aes128gcm` body of one record: the header (salt, record size, the sender's
 * public key as key id), then the record. Null when it does not decrypt for [keys].
 */
internal fun decryptWebPush(body: ByteArray, keys: DeviceKeys): ByteArray? {
    if (body.size < HEADER_BYTES + PUBLIC_KEY_BYTES + TAG_BYTES || body[HEADER_BYTES - 1].toInt() != PUBLIC_KEY_BYTES) {
        return null
    }
    val salt = body.copyOfRange(0, SALT_BYTES)
    val senderKey = body.copyOfRange(HEADER_BYTES, HEADER_BYTES + PUBLIC_KEY_BYTES)
    val record = body.copyOfRange(HEADER_BYTES + PUBLIC_KEY_BYTES, body.size)
    val plaintext = try {
        val shared = keys.agree(p256PublicKey(senderKey))
        val info = "WebPush: info\u0000".toByteArray() + keys.publicKey + senderKey
        val ikm = hkdf(keys.authSecret, shared, info, 32)
        val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\u0000".toByteArray(), 16)
        val nonce = hkdf(salt, ikm, "Content-Encoding: nonce\u0000".toByteArray(), 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
        cipher.doFinal(record)
    } catch (_: GeneralSecurityException) {
        return null
    }
    // The last record ends with the delimiter 0x02, then zero padding.
    val end = plaintext.indexOfLast { it != 0.toByte() }
    if (end < 0 || plaintext[end] != LAST_RECORD_DELIMITER) {
        return null
    }
    return plaintext.copyOfRange(0, end)
}

/** A P-256 public key from its 65 uncompressed bytes. */
internal fun p256PublicKey(uncompressed: ByteArray): PublicKey {
    if (uncompressed[0].toInt() != 4) {
        throw GeneralSecurityException("not an uncompressed point")
    }
    val parameters = AlgorithmParameters.getInstance("EC")
    parameters.init(ECGenParameterSpec("secp256r1"))
    val x = BigInteger(1, uncompressed.copyOfRange(1, 33))
    val y = BigInteger(1, uncompressed.copyOfRange(33, 65))
    val spec = ECPublicKeySpec(ECPoint(x, y), parameters.getParameterSpec(ECParameterSpec::class.java))
    return KeyFactory.getInstance("EC").generatePublic(spec)
}

/** HKDF-SHA-256 (RFC 5869) of at most 32 bytes: one expand block. */
private fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, bytes: Int): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(salt, "HmacSHA256"))
    val prk = mac.doFinal(ikm)
    mac.init(SecretKeySpec(prk, "HmacSHA256"))
    return mac.doFinal(ByteBuffer.allocate(info.size + 1).put(info).put(1).array()).copyOf(bytes)
}

/** `SAppPush` of `@bellaclaw/shared`. */
@Serializable
private class PushBody(
    val conversationKey: String,
    val messageId: Long,
    val revision: Long,
    val text: String,
    val truncated: Boolean,
) {
    fun toAppPush() = AppPush(conversationKey, messageId, revision, text, truncated)
}
