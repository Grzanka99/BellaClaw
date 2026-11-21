package one.scary.bellaclaw.ui.chat

import one.scary.bellaclaw.model.ChatProvider
import one.scary.bellaclaw.model.Effort
import one.scary.bellaclaw.model.ModelChoice

/**
 * [wanted] made a choice [providers] allow: its provider if usable, else the first usable one; its
 * model if that provider lists it, else the provider's first; its effort if the model supports it,
 * else MEDIUM if listed, else the first listed. Null when no usable provider lists a model.
 */
fun pickerSelection(wanted: ModelChoice?, providers: List<ChatProvider>): ModelChoice? {
    val usable = providers.filter { it.isUsable && it.models.isNotEmpty() }
    val provider = usable.firstOrNull { it.id == wanted?.providerId } ?: usable.firstOrNull() ?: return null
    val model = provider.models.firstOrNull { it.id == wanted?.model } ?: provider.models.first()
    val effort = wanted?.effort?.takeIf { it in model.efforts }
        ?: Effort.MEDIUM.takeIf { it in model.efforts }
        ?: model.efforts.firstOrNull()
        ?: return null
    return ModelChoice(provider.id, model.id, effort)
}
