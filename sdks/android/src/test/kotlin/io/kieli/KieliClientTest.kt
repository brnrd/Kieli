package io.kieli
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files
import java.io.File
class KieliClientTest {
    @Test fun sharedFormattingAndFallbackFixtures() {
        val fixtures = JSONArray(javaClass.classLoader!!.getResource("messages.json")!!.readText())
        for (i in 0 until fixtures.length()) {
            val fixture = fixtures.getJSONObject(i)
            val locale = fixture.getString("locale")
            val directory = Files.createTempDirectory("kieli-test").toFile()
            try {
                val saved = JSONObject().put("endpoint", "https://copy.example.com/ota/mobile/$locale?channel=production").put("etag", "fixture").put("bundle", fixture.getJSONObject("bundle"))
                File(directory, "kieli-mobile-$locale-production.json").writeText(saved.toString())
                val client = KieliClient("https://copy.example.com", "mobile", locale, "a".repeat(32), directory)
                val checks = fixture.getJSONArray("checks")
                for (j in 0 until checks.length()) {
                    val check = checks.getJSONArray(j)
                    val args = check.getJSONObject(1)
                    assertEquals("$locale $check", check.getString(2), client.text(check.getString(0), "FALLBACK", args.keys().asSequence().associateWith { args.getString(it) }))
                }
            } finally { directory.deleteRecursively() }
        }
    }
    @Test fun insecureEndpointsAreRejected() {
        val directory = Files.createTempDirectory("kieli-test").toFile()
        try {
            for (url in listOf("http://copy.example.com", "https://user:pass@copy.example.com", "https://copy.example.com/path")) {
                try { KieliClient(url, "mobile", "en", "a".repeat(32), directory); throw AssertionError("Accepted $url") } catch (_: IllegalArgumentException) { }
            }
        } finally { directory.deleteRecursively() }
    }
}
