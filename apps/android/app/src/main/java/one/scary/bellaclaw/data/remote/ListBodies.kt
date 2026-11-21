package one.scary.bellaclaw.data.remote

import kotlinx.serialization.Serializable

// Request and answer bodies of the gateway's list routes.

/** GET /api/lists, and POST /api/lists/changes after the change: the lists that have not ended, oldest first. */
@Serializable
data class ListsBody(val lists: List<ListBody>)

/** [expiresAt], [updatedAt]: epoch ms; [expiresAt] null for a list that never ends. Items by position. */
@Serializable
data class ListBody(
    val id: String,
    val name: String,
    val expiresAt: Long? = null,
    val updatedAt: Long,
    val items: List<ListItemBody>,
)

@Serializable
data class ListItemBody(val id: String, val text: String, val done: Boolean)

/** POST /api/lists/changes: applied in order, all or none. */
@Serializable
class ListChangesBody(val operations: List<ListOperationBody>)

/** One operation; [op] names it and which other fields it has. Null fields are left out of the JSON. */
@Serializable
class ListOperationBody(
    val op: String,
    val listId: String? = null,
    val itemId: String? = null,
    val name: String? = null,
    val text: String? = null,
    val done: Boolean? = null,
    val items: List<String>? = null,
    val toIndex: Int? = null,
)

/** A list's "finished" row of history: the list's [name] and its item count. */
@Serializable
data class ListFinishedBody(val name: String, val total: Int)
