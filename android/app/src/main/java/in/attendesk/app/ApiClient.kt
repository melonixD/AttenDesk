package `in`.attendesk.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

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

    fun verifyOtp(email: String, code: String, installationId: String, deviceName: String): LoginResult {
        val response = post("/api/auth/verify-otp", JSONObject().apply {
            put("email", email)
            put("code", code)
            put("clientType", "mobile")
            put("installationId", installationId)
            put("deviceName", deviceName)
            put("platform", "android")
        }, authenticated = false)
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

    fun requestDeviceChange(email: String, installationId: String, deviceName: String, reason: String, verificationToken: String) {
        post("/api/auth/device-change-request", JSONObject().apply {
            put("email", email)
            put("installationId", installationId)
            put("deviceName", deviceName)
            put("reason", reason)
        }, bearerOverride = verificationToken)
    }

    fun teacherClasses(): List<ClassOffering> {
        val array = getArray("/api/teacher/classes")
        return (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            ClassOffering(
                id = item.getString("id"), subject = item.getString("subject"), code = item.getString("code"),
                branch = item.getString("branch"), section = item.getString("section"), defaultRoom = item.getString("default_room"),
                attendanceThreshold = item.getDouble("attendance_threshold")
            )
        }
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

    fun startSession(offeringId: String, roomId: String, durationSeconds: Int): AttendanceSession =
        post("/api/attendance/sessions", JSONObject().apply {
            put("offeringId", offeringId); put("room", roomId); put("durationSeconds", durationSeconds)
        }).toSession()

    fun resolveBeacon(beaconToken: String): AttendanceSession =
        get("/api/attendance/beacons/$beaconToken").toSession()

    fun session(sessionId: String): AttendanceSession =
        get("/api/attendance/sessions/$sessionId").toSession()

    fun markAttendance(sessionId: String, barcode: String, installationId: String, rssi: List<Int>, beaconToken: String) {
        post("/api/attendance/sessions/$sessionId/mark", JSONObject().apply {
            put("barcode", barcode); put("installationId", installationId)
            put("rssiSamples", JSONArray(rssi))
            // The server now requires proof of which beacon was actually heard.
            // For an ESP32 room this is the rotating code and it expires in 30s.
            put("beaconToken", beaconToken)
        })
    }

    fun markManual(sessionId: String, studentId: String, reason: String) {
        post("/api/attendance/sessions/$sessionId/manual", JSONObject().apply {
            put("studentId", studentId); put("status", "present"); put("reason", reason)
        })
    }

    fun closeSession(sessionId: String) {
        post("/api/attendance/sessions/$sessionId/close", JSONObject())
    }

    private fun JSONObject.toSession(): AttendanceSession {
        val rosterJson = optJSONArray("roster") ?: JSONArray()
        val roster = (0 until rosterJson.length()).map { index ->
            rosterJson.getJSONObject(index).let { item ->
                RosterStudent(
                    id = item.getString("id"), name = item.getString("full_name"), rollNumber = item.getString("roll_number"),
                    status = item.getString("status"), method = item.optString("method").takeIf { it.isNotBlank() && it != "null" }
                )
            }
        }
        val ends = optString("ends_at")
        return AttendanceSession(
            id = getString("id"), beaconToken = optString("beaconToken"), subject = getString("subject"),
            subjectCode = getString("subject_code"), branch = getString("branch"), section = getString("section"),
            teacher = getString("teacher"), roomId = getString("room"),
            endsAt = runCatching { Instant.parse(ends).toEpochMilli() }.getOrElse { System.currentTimeMillis() },
            status = getString("status"), roster = roster
        )
    }

    private fun get(path: String): JSONObject = JSONObject(request(path, "GET", null))
    private fun getArray(path: String): JSONArray = JSONArray(request(path, "GET", null))
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
