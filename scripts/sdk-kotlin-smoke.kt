import io.keylo.KeyloClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
fun main(args: Array<String>) {
    val fixtures=JSONArray(File(args[0]).readText());var count=0
    for(i in 0 until fixtures.length()) {
        val fixture=fixtures.getJSONObject(i);val locale=fixture.getString("locale")
        val directory=Files.createTempDirectory("keylo-kotlin-test").toFile()
        try {
            val saved=JSONObject().put("endpoint","https://copy.example.com/ota/mobile/$locale?channel=production").put("etag","fixture").put("bundle",fixture.getJSONObject("bundle"))
            File(directory,"keylo-mobile-$locale-production.json").writeText(saved.toString())
            val client=KeyloClient("https://copy.example.com","mobile",locale,"a".repeat(32),directory)
            val checks=fixture.getJSONArray("checks")
            for(j in 0 until checks.length()) {
                val item=checks.getJSONArray(j);val arguments=item.getJSONObject(1)
                val actual=client.text(item.getString(0),"FALLBACK",arguments.keys().asSequence().associateWith{arguments.getString(it)})
                check(actual==item.getString(2)) {"$locale $item got $actual"};count++
            }
        } finally {directory.deleteRecursively()}
    }
    println("Kotlin SDK: $count shared formatting and fallback checks passed.")
}
