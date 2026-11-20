package one.scary.bellaclaw.data.push

import one.scary.bellaclaw.model.AppPush
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushDecryptionTest {
    private val push = AppPush("bella:acct-1", kind = "bella", messageId = 42, text = "Zażółć gęślą jaźń")
    private val pushJson =
        """{"conversationKey":"bella:acct-1","kind":"bella","messageId":42,"revision":7,"text":"Zażółć gęślą jaźń","truncated":false}"""

    @Test
    fun `the RFC 8291 Appendix A message decrypts with the receiver's keys`() {
        val keys = softwareKeys(
            p256PrivateKey(base64Url("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")),
            base64Url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
            base64Url("BTBZMqHH6r4Tts7J_aSIgg"),
        )
        val body = base64Url(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        )

        assertEquals("When I grow up, I want to be a watermelon", decryptWebPush(body, keys)?.decodeToString())
    }

    @Test
    fun `a message encrypted like the server does decrypts into the push`() {
        val keys = newSoftwareKeys()

        assertEquals(push, decryptPush(encryptLikeServer(pushJson, keys), keys))
    }

    @Test
    fun `a message for another key is dropped`() {
        assertNull(decryptPush(encryptLikeServer(pushJson, newSoftwareKeys()), newSoftwareKeys()))
    }
}
