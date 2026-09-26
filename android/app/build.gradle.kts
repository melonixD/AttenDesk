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
        versionCode = 4
        versionName = "1.2.0"

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

    buildTypes {
        debug {
            manifestPlaceholders["usesCleartext"] = "true"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            manifestPlaceholders["usesCleartext"] = "false"
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

dependencies {
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
