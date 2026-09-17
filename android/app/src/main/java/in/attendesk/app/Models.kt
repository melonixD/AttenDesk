package `in`.attendesk.app

data class ClassOffering(
    val id: String,
    val subject: String,
    val code: String,
    val branch: String,
    val section: String,
    val defaultRoom: String,
    val attendanceThreshold: Double
)

data class RosterStudent(
    val id: String,
    val name: String,
    val rollNumber: String,
    val status: String,
    val method: String?
)

data class AttendanceSession(
    val id: String,
    val beaconToken: String,
    val subject: String,
    val subjectCode: String,
    val branch: String,
    val section: String,
    val teacher: String,
    val roomId: String,
    val endsAt: Long,
    val status: String,
    val roster: List<RosterStudent> = emptyList()
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
