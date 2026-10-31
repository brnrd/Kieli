package io.keylo

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.io.File
import java.net.URI
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.Executor
import javax.net.ssl.HttpsURLConnection
import kotlin.math.abs
import kotlin.math.floor

/** One instance per locale/channel. Call refreshAsync on launch; text() is synchronous. */
class KeyloClient(baseUrl: String, private val project: String, private val locale: String,
                  private val deliveryKey: String, cacheDirectory: File, channel: String = "production") {
    private val endpoint: URI
    private val cache: File
    private val networkLock = Any()
    @Volatile private var current: JSONObject? = null
    init {
        val base = URI(baseUrl)
        require(base.scheme == "https" && base.host != null && base.rawUserInfo == null && base.rawQuery == null && base.rawFragment == null && base.path in listOf("", "/"))
        require(Regex("[a-z0-9][a-z0-9-]{0,47}").matches(project) && Regex("[A-Za-z0-9-]{2,50}").matches(locale))
        require(channel in listOf("production", "preview") && Regex("[A-Za-z0-9_.-]{20,200}").matches(deliveryKey))
        endpoint = base.resolve("/ota/$project/$locale?channel=$channel")
        require(cacheDirectory.isDirectory || cacheDirectory.mkdirs())
        cache = File(cacheDirectory, "keylo-$project-$locale-$channel.json")
        try {
            val file = cache
            if (file.length() <= 3 * 1024 * 1024) {
                val saved = JSONObject(file.readText())
                if (saved.getString("endpoint") == endpoint.toString() && valid(saved.getJSONObject("bundle"))) current = saved
            }
        } catch (_: Exception) { /* Bundled copy remains available. */ }
    }
    /** Runs on the supplied background executor. Callback also runs on that executor. */
    fun refreshAsync(executor: Executor, callback: (Boolean) -> Unit = {}) {
        executor.execute { callback(refresh()) }
    }
    /** Blocking network operation: call from a background thread, never the main thread. */
    fun refresh(): Boolean = synchronized(networkLock) { refreshLocked() }
    private fun refreshLocked(): Boolean {
        var connection: HttpsURLConnection? = null
        try {
            val conn = endpoint.toURL().openConnection() as HttpsURLConnection
            connection = conn
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.connectTimeout = 10000; conn.readTimeout = 10000
            conn.setRequestProperty("Authorization", "Bearer $deliveryKey")
            current?.optString("etag")?.takeIf { it.isNotEmpty() }?.let { conn.setRequestProperty("If-None-Match", it) }
            if (conn.responseCode == 304) return false
            if (conn.responseCode != 200 || conn.contentLengthLong > 2 * 1024 * 1024) return false
            val output = ByteArrayOutputStream()
            conn.inputStream.use { input ->
                val buffer = ByteArray(8192)
                while (true) { val count = input.read(buffer); if (count < 0) break
                    if (output.size() + count > 2 * 1024 * 1024) return false
                    output.write(buffer, 0, count)
                }
            }
            val bundle = JSONObject(output.toString("UTF-8"))
            if (!valid(bundle)) return false
            val saved = JSONObject().put("endpoint", endpoint.toString()).put("etag", conn.getHeaderField("ETag") ?: "").put("bundle", bundle)
            val temporary = File(cache.path + ".tmp")
            FileOutputStream(temporary).use { stream -> stream.write(saved.toString().toByteArray(Charsets.UTF_8)); stream.fd.sync() }
            check(temporary.renameTo(cache)) { "Could not install translation cache" }
            current = saved
            return true
        } catch (_: Exception) { return false }
        finally { connection?.disconnect() }
    }
    /** Numeric arguments use decimal strings, for example mapOf("count" to "3"). */
    @Synchronized fun text(key: String, fallback: String, arguments: Map<String, String> = emptyMap()): String { return try {
        val bundle = current?.getJSONObject("bundle") ?: return fallback
        render(bundle.getJSONObject("messages").getJSONObject(key).getJSONArray("nodes"), arguments, bundle, null, 0)
    } catch (_: Exception) { fallback } }
    private fun valid(bundle: JSONObject): Boolean = bundle.getInt("schema") == 1 && bundle.getString("project") == project && bundle.getString("locale") == locale && bundle.getJSONObject("messages").length() <= 50000 && bundle.has("rules")
    private fun render(nodes: JSONArray, args: Map<String, String>, bundle: JSONObject, pound: Double?, depth: Int): String {
        require(depth <= 20)
        val result = StringBuilder()
        for (i in 0 until nodes.length()) {
            val node = nodes.getJSONObject(i)
            result.append(when (node.getString("type")) {
                "text" -> node.getString("value")
                "argument" -> requireNotNull(args[node.getString("value")])
                "pound" -> NumberFormat.getNumberInstance(Locale.forLanguageTag(locale)).apply { maximumFractionDigits = 9 }.format(requireNotNull(pound))
                "select" -> {
                    val options = node.getJSONObject("options")
                    val selected = requireNotNull(args[node.getString("value")])
                    render(options.optJSONArray(selected) ?: options.getJSONArray("other"), args, bundle, pound, depth + 1)
                }
                "plural" -> {
                    val rawNumber = requireNotNull(args[node.getString("value")])
                    require(Regex("-?[0-9]{1,13}(\\.[0-9]{1,9})?").matches(rawNumber))
                    val number = rawNumber.toDouble()
                    require(number.isFinite() && abs(number) <= 1e12)
                    val value = number - node.optDouble("offset", 0.0)
                    val options = node.getJSONObject("options")
                    val exact = options.keys().asSequence().firstOrNull { it.startsWith("=") && it.drop(1).toDoubleOrNull() == number }
                    val rules = bundle.getJSONObject("rules").getJSONObject(if (node.optBoolean("ordinal")) "ordinal" else "cardinal")
                    val form = exact ?: category(value, rules)
                    render(options.optJSONArray(form) ?: options.getJSONArray("other"), args, bundle, value, depth + 1)
                }
                else -> error("Unsupported message")
            })
            require(result.length <= 100000)
        }
        return result.toString()
    }
    private fun category(input: Double, rules: JSONObject): String {
        val number = abs(input)
        val decimal = String.format(Locale.ROOT, "%.9f", number).trimEnd('0').trimEnd('.')
        val fraction = decimal.substringAfter('.', "")
        val trimmed = fraction.trimEnd('0')
        val operands = mapOf("n" to number, "i" to floor(number), "v" to fraction.length.toDouble(), "w" to trimmed.length.toDouble(), "f" to (fraction.toDoubleOrNull() ?: 0.0), "t" to (trimmed.toDoubleOrNull() ?: 0.0), "e" to 0.0, "c" to 0.0)
        for (form in listOf("zero", "one", "two", "few", "many")) {
            val groups = rules.optJSONArray(form) ?: continue
            if ((0 until groups.length()).any { g ->
                val group = groups.getJSONArray(g)
                (0 until group.length()).all { r ->
                    val rule = group.getJSONObject(r)
                    var value = operands.getValue(rule.getString("operand"))
                    val mod = rule.getDouble("mod"); if (mod > 0) value %= mod
                    val ranges = rule.getJSONArray("ranges")
                    val match = floor(value) == value && (0 until ranges.length()).any { k -> val range = ranges.getJSONArray(k); value >= range.getDouble(0) && value <= range.getDouble(1) }
                    if (rule.getBoolean("not")) !match else match
                }
            }) return form
        }
        return "other"
    }
}
