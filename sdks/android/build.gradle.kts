plugins {
    id("com.android.library") version "8.9.2"
    id("org.jetbrains.kotlin.android") version "2.2.21"
}
kotlin {
    jvmToolchain(17)
}
android {
    namespace = "io.kieli"
    compileSdk = 35
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
android { testOptions { unitTests.isReturnDefaultValues = true } }
dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
