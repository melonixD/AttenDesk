plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "in.attendesk.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "in.attendesk.app"
        minSdk = 26
        targetSdk = 35
        versionCode = providers.gradleProperty("ATTENDESK_VERSION_CODE").orElse("5").get().toInt()
        versionName = providers.gradleProperty("ATTENDESK_VERSION_NAME").orElse("1.3.0").get()

        val attenDeskApi = providers.gradleProperty("ATTENDESK_API_URL").orElse("https://atten-desk.vercel.app")
        buildConfigField("String", "API_BASE_URL", "\"${attenDeskApi.get()}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    signingConfigs {
        create("attendeskRelease") {
            val keystoreFile = System.getenv("ATTENDESK_KEYSTORE_FILE")
            if (!keystoreFile.isNullOrBlank()) storeFile = file(keystoreFile)
            storePassword = System.getenv("ATTENDESK_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("ATTENDESK_KEY_ALIAS")
            keyPassword = System.getenv("ATTENDESK_KEY_PASSWORD")
        }
    }

    buildTypes {
        debug {
            manifestPlaceholders["usesCleartext"] = "true"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("attendeskRelease")
            manifestPlaceholders["usesCleartext"] = "false"
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

dependencies {
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
