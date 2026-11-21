package one.scary.bellaclaw.data.remote

/** The outcome of one API request. */
sealed interface ApiResult<out T> {
    data class Success<T>(val value: T) : ApiResult<T>

    /**
     * The server answered outside 2xx, or with a 2xx body the client cannot read. [message] is the
     * `error` text of the answer, null when it had none.
     */
    data class ApiError(val status: Int, val message: String?) : ApiResult<Nothing>

    /** No answer: the server could not be reached, or the connection broke. */
    data object NetworkFailure : ApiResult<Nothing>
}
