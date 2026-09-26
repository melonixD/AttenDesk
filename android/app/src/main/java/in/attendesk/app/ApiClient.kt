package `in`.attendesk.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class ApiException(
    val statusCode: Int,
    val code: String,
    val deviceChangeToken: String? = null,
    message: String
) : Exception(message)

class ApiClient(private val baseUrl: String) {
    private var accessToken: String? = null
    private var refreshToken: String? = null

    fun setSession(access: String?, refresh: String?) {
        accessToken = access
        refreshToken = refresh
    }

    fun requestOtp(email: String): String? =
        post("/api/auth/request-otp", JSONObject().put("email", email), authenticated = false)
            .optString("developmentOtp").takeIf { it.isNotBlank() }

    fun latestAppUpdate(): AppUpdate {
        val response = get("/android-update.json", authenticated = false)
        return AppUpdate(
            versionCode = response.optInt("versionCode", 0),
            versionName = response.optString("versionName", "new version"),
            downloadUrl = response.optString("downloadUrl", "/downloads/AttenDesk-student.apk"),
            required = response.optBoolean("required", false),
            notes = response.optString("notes", "A new AttenDesk update is available.")
        )
    }

    fun studentPasswordLogin(
        fullName: String,
        rollNumber: String,
        password: String,
        installationId: String,
        deviceName: String
    ): LoginResult {
        val response = post("/api/auth/student-login", JSONObject().apply {
            put("fullName", fullName)
            put("rollNumber", rollNumber)
            put("password", password)
            put("clientType", "mobile")
            put("installationId", installationId)
            put("deviceName", deviceName)
            put("platform", "android")
        }, authenticated = false)
        return readLoginResult(response)
    }

    fun verifyOtp(email: String, code: String, installationId: String, deviceName: String): LoginResult {
        val response = post("/api/auth/verify-otp", JSONObject().apply {
            put("email", email)
            put("code", code)
            put("clientType", "mobile")
            put("installationId", installationId)
            put("deviceName", deviceName)
            put("platform", "android")
        }, authenticated = false)
        return readLoginResult(response)
    }

    fun requestDeviceChange(installationId: String, deviceName: String, reason: String, verificationToken: String) {
        post("/api/auth/device-change-request", JSONObject().apply {
            put("installationId", installationId)
            put("deviceName", deviceName)
            put("reason", reason)
        }, bearerOverride = verificationToken)
    }

    private fun readLoginResult(response: JSONObject): LoginResult {
        val result = LoginResult(
            accessToken = response.getString("accessToken"),
            refreshToken = response.getString("refreshToken"),
            user = response.getJSONObject("user").let {
                AuthUser(it.getString("id"), it.getString("full_name"), it.getString("email"), it.getString("role"))
            }
        )
        setSession(result.accessToken, result.refreshToken)
        return result
    }

    fun studentDashboard(): StudentDashboard {
        val item = get("/api/student/dashboard")
        val profile = item.optJSONObject("student") ?: JSONObject()
        val subjectsJson = item.optJSONArray("subjects") ?: JSONArray()
        return StudentDashboard(
            threshold = item.getDouble("threshold"), overallPercentage = item.getDouble("overallPercentage"),
            attended = item.getInt("attended"), conducted = item.getInt("conducted"),
            rollNumber = profile.optString("roll_number"), branch = profile.optString("branch"),
            semester = profile.optInt("semester"), section = profile.optString("section"), deviceName = profile.optString("device_name"),
            subjects = (0 until subjectsJson.length()).map { index ->
                subjectsJson.getJSONObject(index).let { subject ->
                    SubjectAttendance(
                        subject = subject.getString("subject"), subjectCode = subject.getString("subject_code"),
                        teacher = subject.getString("teacher"), attended = subject.getInt("attended"),
                        conducted = subject.getInt("conducted"), percentage = subject.getDouble("percentage"),
                        belowThreshold = subject.getBoolean("belowThreshold")
                    )
                }
            }
        )
    }

    fun resolveBeacon(beaconToken: String): AttendanceSession =
        get("/api/attendance/beacons/$beaconToken").toSession()

    fun markAttendance(sessionId: String, barcode: String, installationId: String, rssi: List<Int>, beaconToken: String) {
        post("/api/attendance/sessions/$sessionId/mark", JSONObject().apply {
            put("barcode", barcode); put("installationId", installationId)
            put("rssiSamples", JSONArray(rssi))
            // The server now requires proof of which beacon was actually heard.
            // For an ESP32 room this is the rotating code and it expires in 30s.
            put("beaconToken", beaconToken)
        })
    }

    private fun JSONObject.toSession(): AttendanceSession {
        return AttendanceSession(
            id = getString("id"), subject = getString("subject"), branch = getString("branch"), section = getString("section"),
            teacher = getString("teacher"), roomId = getString("room"),
        )
    }

    private fun get(path: String, authenticated: Boolean = true): JSONObject = JSONObject(request(path, "GET", null, authenticated))
    private fun post(path: String, body: JSONObject, authenticated: Boolean = true, bearerOverride: String? = null): JSONObject =
        JSONObject(request(path, "POST", body, authenticated, bearerOverride))

    private fun request(path: String, method: String, body: JSONObject?, authenticated: Boolean = true, bearerOverride: String? = null, canRefresh: Boolean = true): String {
        val connection = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 10_000
            setRequestProperty("Accept", "application/json")
            val bearer = bearerOverride ?: if (authenticated) accessToken else null
            if (!bearer.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $bearer")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.bufferedWriter().use { it.write(body.toString()) }
            }
        }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val payload = stream?.let { BufferedReader(InputStreamReader(it)).use { reader -> reader.readText() } }.orEmpty()
        if (status == 401 && authenticated && bearerOverride == null && canRefresh && !refreshToken.isNullOrBlank()) {
            val refreshed = JSONObject(request("/api/auth/refresh", "POST", JSONObject().put("refreshToken", refreshToken), authenticated = false, canRefresh = false))
            accessToken = refreshed.getString("accessToken")
            refreshToken = refreshed.getString("refreshToken")
            return request(path, method, body, authenticated, bearerOverride, canRefresh = false)
        }
        if (status !in 200..299) {
            val json = runCatching { JSONObject(payload) }.getOrDefault(JSONObject())
            val errorCode = json.optString("error", "REQUEST_FAILED")
            throw ApiException(status, errorCode, json.optString("deviceChangeToken").takeIf { it.isNotBlank() }, json.optString("message", errorCode))
        }
        return payload.ifBlank { "{}" }
    }
}
