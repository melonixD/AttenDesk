package `in`.attendesk.app

data class AttendanceSession(
    val id: String,
    val subject: String,
    val branch: String,
    val section: String,
    val teacher: String,
    val roomId: String
)

data class NearbySignal(
    val beaconToken: String,
    val samples: List<Int>
) {
    val medianRssi: Int
        get() {
            if (samples.isEmpty()) return -127
            val sorted = samples.sorted()
            return sorted[sorted.size / 2]
        }
}

data class AuthUser(val id: String, val fullName: String, val email: String, val role: String)

data class LoginResult(val accessToken: String, val refreshToken: String, val user: AuthUser)

data class AppUpdate(
    val versionCode: Int,
    val versionName: String,
    val downloadUrl: String,
    val required: Boolean,
    val notes: String
)

data class SubjectAttendance(
    val subject: String,
    val subjectCode: String,
    val teacher: String,
    val attended: Int,
    val conducted: Int,
    val percentage: Double,
    val belowThreshold: Boolean
)

data class StudentDashboard(
    val threshold: Double,
    val overallPercentage: Double,
    val attended: Int,
    val conducted: Int,
    val rollNumber: String,
    val branch: String,
    val semester: Int,
    val section: String,
    val deviceName: String,
    val subjects: List<SubjectAttendance>
)
