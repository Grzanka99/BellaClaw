package one.scary.bellaclaw.ui.lists

import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import one.scary.bellaclaw.data.FakeGateway
import one.scary.bellaclaw.data.TestServer
import one.scary.bellaclaw.data.errorAnswer
import one.scary.bellaclaw.data.listAnswer
import one.scary.bellaclaw.data.listsAnswer
import one.scary.bellaclaw.model.AccountError
import one.scary.bellaclaw.ui.MainDispatcherRule
import one.scary.bellaclaw.ui.collectIn
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.TimeUnit

class ListsViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @get:Rule
    val testServer = TestServer()

    private lateinit var gateway: FakeGateway

    private val shopping = listAnswer("l1", "Shopping", listOf("i1" to ("Milk" to true), "i2" to ("Bread" to false), "i3" to ("Eggs" to false)))
    private val packing = listAnswer("l2", "Packing", listOf("i4" to ("Charger" to false)))

    @Before
    fun setUp() {
        gateway = testServer.gateway()
        gateway.lists = listsAnswer(shopping, packing)
    }

    /** The lists screen opened on [listId], its lists read as the stream's `check` asks, and kept live by its `lists` events. */
    private suspend fun TestScope.viewModel(listId: String = "l1"): ListsViewModel {
        val store = testServer.signedInStore()
        val lists = testServer.listsRepository(store, backgroundScope)
        testServer.chatRepository(store, backgroundScope, onListsChanged = lists::refresh)
        return ListsViewModel(listId, lists, SavedStateHandle()).also { collectIn(it.uiState) }
    }

    private suspend fun takeChange(): JsonObject = withContext(Dispatchers.IO) {
        checkNotNull(gateway.listChanges.poll(5, TimeUnit.SECONDS)) { "no list change arrived" }
    }

    private fun JsonObject.operation() = getValue("operations").jsonArray.single().jsonObject.toString()

    @Test
    fun opensOnTheListWithAChipPerListAndFollowsTheStream() = runTest {
        val viewModel = viewModel("l2")
        val opened = viewModel.uiState.first { it.list != null }
        assertEquals("Packing", opened.list?.name)
        assertEquals(listOf("Shopping", "Packing"), opened.lists.map { it.name })

        gateway.lists = listsAnswer(listAnswer("l2", "Packing", listOf("i4" to ("Charger" to true), "i5" to ("Passport" to false))))
        gateway.push("lists", "{}")
        val changed = viewModel.uiState.first { it.list?.items?.size == 2 }
        assertEquals(listOf(true, false), changed.list?.items?.map { it.done })
        assertEquals(1, changed.lists.size)
    }

    @Test
    fun aTickShowsAtOnceAndIsSent() = runTest {
        val viewModel = viewModel()
        val bread = viewModel.uiState.first { it.list != null }.list!!.items[1]
        gateway.lists = listsAnswer(listAnswer("l1", "Shopping", listOf("i1" to ("Milk" to true), "i2" to ("Bread" to true), "i3" to ("Eggs" to false))), packing)

        viewModel.toggle(bread)

        assertEquals(true, viewModel.uiState.value.list?.items?.get(1)?.done)
        assertEquals("""{"op":"update_item","itemId":"i2","done":true}""", takeChange().operation())
        assertEquals(2, viewModel.uiState.first { it.list?.doneCount == 2 }.list?.doneCount)
    }

    @Test
    fun aRefusedChangeIsUndoneAndSaysWhy() = runTest {
        val viewModel = viewModel()
        val bread = viewModel.uiState.first { it.list != null }.list!!.items[1]
        gateway.listChangeFailures.put(404 to errorAnswer("Item not found"))

        viewModel.toggle(bread)

        val refused = viewModel.uiState.first { it.error != null }
        assertEquals(AccountError.Server(404, "Item not found"), refused.error)
        assertEquals(false, refused.list?.items?.get(1)?.done)
        viewModel.errorShown()
        assertEquals(null, viewModel.uiState.first { it.error == null }.error)
    }

    @Test
    fun editsTheListAndItsItems() = runTest {
        val viewModel = viewModel()
        val milk = viewModel.uiState.first { it.list != null }.list!!.items[0]

        viewModel.onAddDraftChange("  Butter ")
        viewModel.add()
        assertEquals("""{"op":"add_items","listId":"l1","items":["Butter"]}""", takeChange().operation())
        assertEquals("", viewModel.uiState.value.addDraft)

        viewModel.startEdit(milk)
        viewModel.onEditChange("Oat milk")
        viewModel.commitEdit()
        assertEquals("""{"op":"update_item","itemId":"i1","text":"Oat milk"}""", takeChange().operation())

        viewModel.move("i3", 0)
        assertEquals("""{"op":"move_item","itemId":"i3","toIndex":0}""", takeChange().operation())

        viewModel.delete(milk)
        assertEquals("""{"op":"delete_item","itemId":"i1"}""", takeChange().operation())

        viewModel.openRename()
        viewModel.onRenameChange("Groceries")
        viewModel.confirmRename()
        assertEquals("""{"op":"rename_list","listId":"l1","name":"Groceries"}""", takeChange().operation())
        assertEquals(null, viewModel.uiState.value.dialog)
    }

    @Test
    fun deletingTheLastListClosesTheScreen() = runTest {
        gateway.lists = listsAnswer(shopping)
        val viewModel = viewModel()
        viewModel.uiState.first { it.list != null }
        gateway.lists = listsAnswer()

        viewModel.openDelete()
        viewModel.confirmDelete()

        assertEquals("""{"op":"delete_list","listId":"l1"}""", takeChange().operation())
        assertEquals(true, viewModel.uiState.first { it.isGone }.isGone)
    }
}
