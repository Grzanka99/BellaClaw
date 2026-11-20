package one.scary.bellaclaw.data.remote

import kotlinx.serialization.Serializable

/**
 * PUT /api/device: the FCM registration token and the RFC 8291 public key and auth secret, base64url.
 * A plain class, so its toString shows no field.
 */
@Serializable
class DeviceBody(val fcmToken: String, val publicKey: String, val authSecret: String)
