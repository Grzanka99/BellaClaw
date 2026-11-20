package one.scary.bellaclaw.data.push

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyAgreement

private const val KEYSTORE = "AndroidKeyStore"
private const val ALIAS = "push"
private const val AUTH_SECRET_BYTES = 16
private const val COORDINATE_BYTES = 32

/**
 * The device's push keys: a P-256 key pair in the Android Keystore, made for key agreement (the private
 * key never leaves it), and the auth secret in [authSecretFile] (app-private, excluded from backup and
 * device transfer). Made once; when either is missing (a restored phone) both are made anew.
 */
fun loadDeviceKeys(authSecretFile: File): DeviceKeys {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    var privateKey = keyStore.getKey(ALIAS, null) as? PrivateKey
    var publicKey = keyStore.getCertificate(ALIAS)?.publicKey as? ECPublicKey
    var authSecret = authSecretFile.takeIf { it.exists() }?.readBytes()
    if (privateKey == null || publicKey == null || authSecret?.size != AUTH_SECRET_BYTES) {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_AGREE_KEY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .build(),
        )
        val pair = generator.generateKeyPair()
        privateKey = pair.private
        publicKey = pair.public as ECPublicKey
        authSecret = ByteArray(AUTH_SECRET_BYTES).also { SecureRandom().nextBytes(it) }
        authSecretFile.writeBytes(authSecret)
    }
    val key = privateKey
    return DeviceKeys(uncompressed(publicKey), authSecret) { peer ->
        val agreement = KeyAgreement.getInstance("ECDH", KEYSTORE)
        agreement.init(key)
        agreement.doPhase(peer, true)
        agreement.generateSecret()
    }
}

/** The key as an uncompressed point: `0x04`, then x and y in 32 bytes each. */
private fun uncompressed(key: ECPublicKey): ByteArray =
    byteArrayOf(4) + coordinate(key.w.affineX) + coordinate(key.w.affineY)

private fun coordinate(value: BigInteger): ByteArray {
    val bytes = value.toByteArray().takeLast(COORDINATE_BYTES).toByteArray()
    return ByteArray(COORDINATE_BYTES - bytes.size) + bytes
}
