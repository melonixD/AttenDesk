package `in`.attendesk.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import android.widget.Toast
import android.text.InputType
import com.google.android.gms.mlkit.vision.codescanner.GmsBarcodeScanning
import java.util.concurrent.Executors
import kotlin.math.max

class MainActivity : Activity() {
    private val api = ApiClient(BuildConfig.API_BASE_URL)
    private lateinit var ble: BleSessionManager
    private val io = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())
    private var currentSession: AttendanceSession? = null
    private var timerRunnable: Runnable? = null
    private var pollRunnable: Runnable? = null
    private val nearbySignals = linkedMapOf<String, NearbySignal>()
    private val resolvedTokens = mutableSetOf<String>()
    private var signedInUser: AuthUser? = null
    private var closingSession = false
    private val installationId: String by lazy {
        val preferences = getSharedPreferences("attendesk_secure", Context.MODE_PRIVATE)
        preferences.getString("installation_id", null) ?: java.util.UUID.randomUUID().toString().also {
            preferences.edit().putString("installation_id", it).apply()
        }
    }
    private val deviceName: String get() = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ble = BleSessionManager(this)
        if (!ble.hasPermissions()) requestPermissions(ble.requiredPermissions(), 104)
        showRoleChooser()
    }

    override fun onDestroy() {
        timerRunnable?.let(main::removeCallbacks)
        pollRunnable?.let(main::removeCallbacks)
        ble.close()
        io.shutdownNow()
        super.onDestroy()
    }

    private fun showRoleChooser() {
        ble.close()
        timerRunnable?.let(main::removeCallbacks)
        pollRunnable?.let(main::removeCallbacks)
        currentSession = null
        closingSession = false
        val content = column(22).apply {
            setPadding(dp(22), dp(36), dp(22), dp(30))
            addView(label("ATTENDESK", 13, GREEN, bold = true))
            addView(label("One classroom.\nOne clear record.", 38, INK, bold = true).withMargins(top = 14))
            addView(label("Phone-based Bluetooth attendance connected to each student's registered ID card.", 16, MUTED).withMargins(top = 12, bottom = 32))
            addView(roleButton("Continue as teacher", "Sign in and start a timed class session", true) { showLogin("teacher") })
            addView(roleButton("Continue as student", "Sign in, discover your class and scan your ID", false) { showLogin("student") }.withMargins(top = 14))
            addView(space(22))
            addView(label("REGISTERED DEVICE  ·  LIVE BARCODE  ·  TIMED BLE", 10, MUTED, bold = true).apply { gravity = Gravity.CENTER })
        }
        setAnimatedContent(scroll(content))
    }

    private fun showLogin(expectedRole: String, emailValue: String = "", codeSent: Boolean = false, developmentOtp: String? = null) {
        val email = EditText(this).apply {
            hint = "name@college.edu"
            setText(emailValue)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            setPadding(dp(14), dp(4), dp(14), dp(4))
            background = shape(Color.WHITE, 12, LINE)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54))
        }
        val code = EditText(this).apply {
            hint = "6-digit code"
            setText(developmentOtp.orEmpty())
            inputType = InputType.TYPE_CLASS_NUMBER
            setPadding(dp(14), dp(4), dp(14), dp(4))
            background = shape(Color.WHITE, 12, LINE)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54))
        }
        val content = column(14).apply {
            setPadding(dp(22), dp(36), dp(22), dp(30))
            addView(label("COLLEGE EMAIL LOGIN", 11, GREEN_DARK, true))
            addView(label("Continue as ${expectedRole.replaceFirstChar { it.uppercase() }}", 30, INK, true))
            addView(label("We use a one-time code. Students can mark attendance only from their approved phone.", 14, MUTED))
            addView(label("COLLEGE EMAIL", 10, MUTED, true).withMargins(top = 16))
            addView(email)
            if (codeSent) {
                addView(label("VERIFICATION CODE", 10, MUTED, true).withMargins(top = 8))
                addView(code)
                addView(primaryButton("Verify and sign in") { verifyLogin(expectedRole, email.text.toString(), code.text.toString()) })
                addView(label("Code sent. It expires in 10 minutes.", 11, MUTED).apply { gravity = Gravity.CENTER_HORIZONTAL })
            } else {
                addView(primaryButton("Email me a code") { requestLoginCode(expectedRole, email.text.toString()) }.withMargins(top = 8))
            }
            addView(outlineButton("Back") { showRoleChooser() }.withMargins(top = 10))
            addView(label("New student or teacher? Register on the AttenDesk website, then wait for admin approval.", 11, MUTED).withMargins(top = 12))
        }
        setAnimatedContent(scroll(content))
    }

    private fun requestLoginCode(expectedRole: String, email: String) {
        if (!email.contains('@')) return toast("Enter your college email")
        showLoading("Sending your secure login code…")
        io.execute {
            runCatching { api.requestOtp(email.trim().lowercase()) }
                .onSuccess { otp -> main.post { showLogin(expectedRole, email.trim().lowercase(), true, otp) } }
                .onFailure { error -> main.post { showNetworkError(error) } }
        }
    }

    private fun verifyLogin(expectedRole: String, email: String, code: String) {
        if (code.length != 6) return toast("Enter the 6-digit code")
        showLoading("Verifying your account and device…")
        io.execute {
            runCatching { api.verifyOtp(email.trim().lowercase(), code, installationId, deviceName) }
                .onSuccess { login ->
                    if (login.user.role != expectedRole) {
                        main.post { showError("Wrong account type", "This account is registered as ${login.user.role}.") }
                        return@onSuccess
                    }
                    signedInUser = login.user
                    main.post { if (login.user.role == "teacher") showTeacherLoading() else showStudentLoading() }
                }
                .onFailure { error -> main.post {
                    if (error is ApiException && error.code == "DEVICE_CHANGE_REQUIRED" && error.deviceChangeToken != null) {
                        showDeviceChangeDialog(email.trim().lowercase(), error.deviceChangeToken)
                    } else showNetworkError(error)
                } }
        }
    }

    private fun showDeviceChangeDialog(email: String, verificationToken: String) {
        val reason = EditText(this).apply { hint = "Why are you changing phones?"; setPadding(dp(14), dp(10), dp(14), dp(10)) }
        AlertDialog.Builder(this)
            .setTitle("New phone detected")
            .setMessage("Your account is linked to another phone. Ask an administrator to approve this device: $deviceName")
            .setView(reason)
            .setNegativeButton("Cancel") { _, _ -> showRoleChooser() }
            .setPositiveButton("Request approval") { _, _ ->
                val explanation = reason.text.toString().trim().ifBlank { "Phone replaced or reset" }
                showLoading("Sending device approval request…")
                io.execute {
                    runCatching { api.requestDeviceChange(email, installationId, deviceName, explanation, verificationToken) }
                        .onSuccess { main.post { showSuccess("Request sent", "An administrator must approve this phone before you can mark attendance.") { showRoleChooser() } } }
                        .onFailure { error -> main.post { showNetworkError(error) } }
                }
            }.show()
    }

    private fun showTeacherLoading() {
        showLoading("Preparing your classes…")
        io.execute {
            runCatching { api.teacherClasses() }
                .onSuccess { classes -> main.post {
                    if (classes.isEmpty()) showError("No classes assigned", "Ask an administrator to create a course offering for you.")
                    else showTeacherDashboard(classes, classes.first())
                } }
                .onFailure { error -> main.post { showNetworkError(error) } }
        }
    }

    private fun showTeacherDashboard(classes: List<ClassOffering>, offering: ClassOffering) {
        var selectedMinutes = 3
        val room = EditText(this).apply {
            hint = "Room number"
            setText(offering.defaultRoom)
            setPadding(dp(14), dp(4), dp(14), dp(4))
            background = shape(Color.WHITE, 12, LINE)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50))
        }
        val content = column(16).apply {
            setPadding(dp(18), dp(24), dp(18), dp(30))
            addView(topRow("Hello, ${signedInUser?.fullName ?: "Teacher"}.", "TEACHER DASHBOARD"))
            addView(row(8).apply {
                addView(metric(classes.size.toString().padStart(2, '0'), "Classes"), LinearLayout.LayoutParams(0, dp(110), 1f))
                addView(metric("${formatPercent(offering.attendanceThreshold)}%", "Threshold"), LinearLayout.LayoutParams(0, dp(110), 1f))
                addView(metric("BLE", "Method"), LinearLayout.LayoutParams(0, dp(110), 1f))
            })
            addView(card().apply {
                addView(row().apply {
                    addView(column(2).apply {
                        addView(label("NEXT CLASS", 10, GREEN_DARK, true))
                        addView(label(offering.subject, 25, INK, true))
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    })
                    addView(chip("ROOM ${offering.defaultRoom}", PALE_GREEN, GREEN_DARK))
                })
                addView(label("${offering.code}  ·  ${offering.branch}  ·  Section ${offering.section}", 12, MUTED).withMargins(top = 8, bottom = 18))
                addView(outlineButton("Choose another class") {
                    AlertDialog.Builder(this@MainActivity).setTitle("Select class")
                        .setItems(classes.map { "${it.code} · ${it.subject} · Room ${it.defaultRoom}" }.toTypedArray()) { _, which -> showTeacherDashboard(classes, classes[which]) }
                        .show()
                })
                addView(label("CLASSROOM", 10, MUTED, true).withMargins(top = 12, bottom = 4))
                addView(room)
                addView(infoStrip("●  Teacher phone beacon ready", "Students will discover this session nearby"))
                addView(label("ATTENDANCE WINDOW", 10, MUTED, true).withMargins(top = 20, bottom = 8))
                val minuteRow = row(7)
                val minuteButtons = mutableListOf<Button>()
                listOf(1, 3, 5, 10).forEach { minutes ->
                    minuteRow.addView(smallButton("$minutes min", minutes == 3) { clicked ->
                        selectedMinutes = minutes
                        minuteButtons.forEach { styleMiniButton(it, it == clicked) }
                    }.also(minuteButtons::add), LinearLayout.LayoutParams(0, dp(43), 1f))
                }
                addView(minuteRow)
                addView(primaryButton("Start Bluetooth attendance") {
                    val selectedRoom = room.text.toString().trim()
                    if (selectedRoom.isBlank()) toast("Enter the classroom number") else startTeacherSession(offering, selectedRoom, selectedMinutes)
                }.withMargins(top = 18))
            })
            addView(infoStrip("Reports are stored centrally", "Open the AttenDesk website for Excel, PDF and below-${formatPercent(offering.attendanceThreshold)}% reports."))
        }
        setAnimatedContent(scroll(content))
    }

    private fun startTeacherSession(offering: ClassOffering, room: String, minutes: Int) {
        showLoading("Opening Room $room…")
        io.execute {
            runCatching { api.startSession(offering.id, room, minutes * 60) }
                .onSuccess { session ->
                    currentSession = session
                    ble.startTeacherBroadcast(session.beaconToken, session.roomId,
                        onStarted = { main.post { showTeacherLive(session) } },
                        onError = { message ->
                            io.execute {
                                val closed = runCatching { api.closeSession(session.id) }.isSuccess
                                main.post {
                                    val cleanup = if (closed) "The server session was closed." else "The server could not confirm closure; it will expire automatically at the original end time."
                                    showError("Bluetooth broadcast failed", "$message\n\n$cleanup")
                                }
                            }
                        }
                    )
                }
                .onFailure { error -> main.post { showNetworkError(error) } }
        }
    }

    private fun showTeacherLive(session: AttendanceSession) {
        closingSession = false
        val content = column(14).apply {
            setPadding(dp(18), dp(24), dp(18), dp(30))
            addView(topRow("${session.subject} · Room ${session.roomId}", "● LIVE ATTENDANCE"))
            val timer = label("03:00", 36, INK, true).apply { gravity = Gravity.CENTER_HORIZONTAL }
            addView(timer.withMargins(top = 12))
            addView(label("remaining", 11, MUTED).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(card().apply {
                addView(label("LIVE ROSTER", 10, GREEN_DARK, true))
                tag = "roster-card"
                renderRoster(this, session.roster)
            }.withMargins(top = 12))
            addView(outlineButton("End attendance") { closeTeacherSession() })
        }
        setAnimatedContent(scroll(content))
        timerRunnable?.let(main::removeCallbacks)
        timerRunnable = object : Runnable {
            override fun run() {
                val seconds = max(0, ((session.endsAt - System.currentTimeMillis()) / 1000).toInt())
                timer.text = "%02d:%02d".format(seconds / 60, seconds % 60)
                if (seconds > 0) main.postDelayed(this, 1000) else closeTeacherSession()
            }
        }.also(main::post)
        pollTeacherSession()
    }

    private fun pollTeacherSession() {
        val id = currentSession?.id ?: return
        pollRunnable?.let(main::removeCallbacks)
        pollRunnable = object : Runnable {
            override fun run() {
                io.execute {
                    runCatching { api.session(id) }.onSuccess { latest ->
                        currentSession = latest
                        main.post {
                            val root = findViewById<ViewGroup>(android.R.id.content)
                            val roster = findTaggedView(root, "roster-card") as? LinearLayout
                            roster?.let { renderRoster(it, latest.roster) }
                        }
                    }
                }
                main.postDelayed(this, 2000)
            }
        }.also(main::post)
    }

    private fun renderRoster(container: LinearLayout, roster: List<RosterStudent>) {
        while (container.childCount > 1) container.removeViewAt(1)
        val present = roster.count { it.status == "present" }
        container.addView(label("$present present  ·  ${roster.size - present} waiting", 13, MUTED, true).withMargins(top = 8, bottom = 8))
        roster.forEach { student ->
            container.addView(row().apply {
                setPadding(0, dp(10), 0, dp(10))
                addView(initial(student.name))
                addView(column(1).apply {
                    addView(label(student.name, 13, INK, true))
                    addView(label("${student.rollNumber}${student.method?.let { " · $it" } ?: ""}", 10, MUTED))
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(10) }
                })
                val marked = student.status == "present"
                addView(smallButton(if (marked) "✓" else "+", marked) {
                    if (!marked) showManualDialog(student)
                }.apply { minimumWidth = dp(42) })
            })
        }
    }

    private fun showManualDialog(student: RosterStudent) {
        val reasons = arrayOf("ID card forgotten", "Phone unavailable", "Bluetooth issue", "Approved by teacher")
        AlertDialog.Builder(this)
            .setTitle("Mark ${student.name} present?")
            .setSingleChoiceItems(reasons, 0, null)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Confirm") { dialog, _ ->
                val selected = (dialog as AlertDialog).listView.checkedItemPosition.coerceAtLeast(0)
                val sessionId = currentSession?.id ?: return@setPositiveButton
                io.execute {
                    runCatching { api.markManual(sessionId, student.id, reasons[selected]) }
                        .onSuccess { main.post { toast("Manual attendance recorded"); pollTeacherSession() } }
                        .onFailure { error -> main.post { toast(error.message ?: "Manual attendance failed") } }
                }
            }
            .show()
    }

    private fun closeTeacherSession() {
        val id = currentSession?.id ?: return showRoleChooser()
        if (closingSession) return
        closingSession = true
        timerRunnable?.let(main::removeCallbacks)
        pollRunnable?.let(main::removeCallbacks)
        ble.stopTeacherBroadcast()
        showLoading("Closing attendance and saving the final roster…")
        io.execute {
            runCatching { api.closeSession(id) }
                .onSuccess { main.post {
                    currentSession = null
                    closingSession = false
                    showSuccess("Attendance saved", "The Bluetooth session is closed and the final roster is ready.") { showRoleChooser() }
                } }
                .onFailure { error -> main.post {
                    closingSession = false
                    AlertDialog.Builder(this)
                        .setTitle("Attendance was not confirmed saved")
                        .setMessage(error.message ?: "Check the connection and try again.")
                        .setPositiveButton("Retry") { _, _ -> closeTeacherSession() }
                        .setNegativeButton("Return to dashboard") { _, _ -> currentSession = null; showTeacherLoading() }
                        .show()
                } }
        }
    }

    private fun showStudentLoading() {
        showLoading("Loading your attendance record…")
        io.execute {
            runCatching { api.studentDashboard() }
                .onSuccess { dashboard -> main.post { showStudentDashboard(dashboard) } }
                .onFailure { error -> main.post { showNetworkError(error) } }
        }
    }

    private fun showStudentDashboard(dashboard: StudentDashboard) {
        val onTrack = dashboard.conducted == 0 || dashboard.overallPercentage >= dashboard.threshold
        val content = column(16).apply {
            setPadding(dp(18), dp(24), dp(18), dp(30))
            addView(topRow("Hello, ${signedInUser?.fullName ?: "Student"}.", "REGISTERED DEVICE · ${dashboard.rollNumber}"))
            addView(card(DARK).apply {
                addView(label("YOUR ATTENDANCE", 10, GREEN, true))
                addView(label("${formatPercent(dashboard.overallPercentage)}% overall", 31, Color.WHITE, true).withMargins(top = 8))
                val summary = if (dashboard.conducted == 0) "No classes have been conducted yet." else if (onTrack) "You're on track. Keep attending to stay above ${formatPercent(dashboard.threshold)}%." else "Your attendance is below the required ${formatPercent(dashboard.threshold)}%."
                addView(label(summary, 13, Color.rgb(219, 234, 254)).withMargins(top = 4))
                addView(label("${dashboard.attended} attended · ${dashboard.conducted} conducted · ${dashboard.branch} ${dashboard.section}", 11, Color.rgb(219, 234, 254)).withMargins(top = 8))
            })
            val nearbyCard = card().apply {
                tag = "nearby-card"
                addView(row().apply {
                    addView(column(2).apply {
                        addView(label("● SCANNING NEARBY", 10, GREEN_DARK, true))
                        addView(label("Available attendance", 22, INK, true).withMargins(top = 4))
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    })
                    addView(chip("ᛒ ON", PALE_GREEN, GREEN_DARK))
                })
                addView(label("Looking for a teacher's AttenDesk…", 13, MUTED).apply { gravity = Gravity.CENTER }.withMargins(top = 55, bottom = 55))
            }
            addView(nearbyCard)
            addView(label("SUBJECT-WISE RECORD", 10, GREEN_DARK, true).withMargins(top = 8))
            dashboard.subjects.forEach { subject ->
                addView(subjectCard(subject.subject, "${subject.attended} of ${subject.conducted} · ${subject.teacher}", "${formatPercent(subject.percentage)}%", warning = subject.belowThreshold))
            }
            if (dashboard.subjects.isEmpty()) addView(infoStrip("No subjects assigned", "Ask the administrator to enroll you in your courses."))
        }
        setAnimatedContent(scroll(content))
        nearbySignals.clear()
        resolvedTokens.clear()
        ble.startStudentScan(onSignal = { signal ->
            nearbySignals[signal.beaconToken] = signal
            if (signal.samples.size >= 3 && resolvedTokens.add(signal.beaconToken)) resolveNearbySession(signal)
        }, onError = { message -> main.post { showError("Bluetooth unavailable", message) } })
    }

    private fun resolveNearbySession(signal: NearbySignal) {
        io.execute {
            runCatching { api.resolveBeacon(signal.beaconToken) }
                .onSuccess { session -> main.post { renderNearbyBubble(session, signal) } }
                .onFailure { resolvedTokens.remove(signal.beaconToken) }
        }
    }

    private fun renderNearbyBubble(session: AttendanceSession, signal: NearbySignal) {
        currentSession = session
        val root = findViewById<ViewGroup>(android.R.id.content)
        val card = findTaggedView(root, "nearby-card") as? LinearLayout ?: return
        while (card.childCount > 1) card.removeViewAt(1)
        val bubble = Button(this).apply {
            text = "ROOM ${session.roomId}\n${session.subject}\n${session.teacher}\n\nTAP TO JOIN"
            textSize = 15f
            setTextColor(Color.WHITE)
            isAllCaps = false
            gravity = Gravity.CENTER
            typeface = Typeface.DEFAULT_BOLD
            background = shape(GREEN_DARK, radius = 110)
            setOnClickListener { scanStudentCard(session, signal) }
            alpha = 0f
            scaleX = 0.84f
            scaleY = 0.84f
        }
        card.addView(bubble, LinearLayout.LayoutParams(dp(210), dp(210)).apply { gravity = Gravity.CENTER; topMargin = dp(28); bottomMargin = dp(18) })
        bubble.animate()
            .alpha(1f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(440L)
            .setInterpolator(OvershootInterpolator(0.82f))
            .start()
        card.addView(label("Signal ${signal.medianRssi} dBm · ${session.branch} · Section ${session.section}", 11, MUTED).apply { gravity = Gravity.CENTER })
    }

    private fun scanStudentCard(session: AttendanceSession, signal: NearbySignal) {
        val scanner = GmsBarcodeScanning.getClient(this)
        scanner.startScan()
            .addOnSuccessListener { barcode ->
                val value = barcode.rawValue ?: return@addOnSuccessListener showError("No barcode found", "Please scan the printed barcode on your college ID card.")
                submitStudentAttendance(session, signal, value)
            }
            .addOnFailureListener { error -> showError("Scanner unavailable", error.message ?: "Try again") }
    }

    private fun submitStudentAttendance(session: AttendanceSession, signal: NearbySignal, barcode: String) {
        showLoading("Verifying your ID and classroom…")
        io.execute {
            runCatching { api.markAttendance(session.id, barcode, installationId, signal.samples) }
                .onSuccess {
                    ble.stopStudentScan()
                    main.post { showSuccess("You're marked present", "${session.subject} · Room ${session.roomId}\nBarcode + Bluetooth verified") { showStudentLoading() } }
                }
                .onFailure { error -> main.post { showError("Attendance not marked", error.message ?: "Verification failed") } }
        }
    }

    private fun showLoading(message: String) {
        val content = column(16).apply {
            setPadding(dp(22), dp(38), dp(22), dp(40))
            addView(label("ATTENDESK", 12, GREEN_DARK, true))
            addView(label(message, 26, INK, true).withMargins(top = 9))
            addView(label("Connecting securely. This usually takes only a moment.", 13, MUTED).withMargins(top = 5, bottom = 15))
            addView(ProgressBar(this@MainActivity).apply {
                isIndeterminate = true
                indeterminateTintList = ColorStateList.valueOf(GREEN_DARK)
                contentDescription = "Loading"
            }, LinearLayout.LayoutParams(dp(34), dp(34)).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(row(10).apply {
                repeat(3) { addView(loadingMetric(), LinearLayout.LayoutParams(0, dp(92), 1f)) }
            }.withMargins(top = 24))
            addView(loadingPanel().withMargins(top = 5))
        }
        setAnimatedContent(scroll(content))
        content.announceForAccessibility(message)
    }

    private fun showNetworkError(error: Throwable) = showError(
        "Cannot reach the AttenDesk server",
        "Start the included server and set API_BASE_URL for your phone.\n\n${error.message ?: "Connection failed"}"
    )

    private fun showError(title: String, message: String) {
        AlertDialog.Builder(this).setTitle(title).setMessage(message).setNegativeButton("Back") { _, _ -> showRoleChooser() }.show()
    }

    private fun showSuccess(title: String, message: String, done: () -> Unit) {
        val content = column(15).apply {
            gravity = Gravity.CENTER
            setPadding(dp(25), dp(80), dp(25), dp(80))
            addView(label("ATTENDESK · VERIFIED", 10, GREEN_DARK, true).apply { gravity = Gravity.CENTER })
            addView(label("✓", 40, Color.WHITE, true).apply { gravity = Gravity.CENTER; background = shape(GREEN, 60); setPadding(0, dp(13), 0, 0) }, LinearLayout.LayoutParams(dp(72), dp(72)).apply { gravity = Gravity.CENTER })
            addView(label(title, 29, INK, true).apply { gravity = Gravity.CENTER }.withMargins(top = 13))
            addView(label(message, 14, MUTED).apply { gravity = Gravity.CENTER })
            addView(primaryButton("Done") { done() }.withMargins(top = 15))
        }
        setAnimatedContent(scroll(content))
    }

    private fun topRow(title: String, eyebrow: String) = row().apply {
        addView(column(2).apply {
            addView(label(eyebrow, 10, GREEN_DARK, true))
            addView(label(title, 25, INK, true).withMargins(top = 5))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        addView(smallButton("Switch", false) { showRoleChooser() })
    }

    private fun metricRow() = row(8).apply {
        addView(metric("04", "Classes"), LinearLayout.LayoutParams(0, dp(110), 1f))
        addView(metric("78.4%", "Average"), LinearLayout.LayoutParams(0, dp(110), 1f))
        addView(metric("03", "Below 75%"), LinearLayout.LayoutParams(0, dp(110), 1f))
    }

    private fun metric(value: String, caption: String) = card(padding = 12).apply {
        addView(label(caption, 10, MUTED, true))
        addView(label(value, 21, INK, true).withMargins(top = 12))
    }

    private fun reportRow(name: String, roll: String, percentage: String) = row().apply {
        setPadding(0, dp(11), 0, dp(11))
        addView(initial(name))
        addView(column(0).apply {
            addView(label(name, 13, INK, true))
            addView(label(roll, 10, MUTED))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(10) }
        })
        addView(label(percentage, 14, WARNING, true))
    }

    private fun subjectCard(name: String, detail: String, percent: String, warning: Boolean = false) = card(padding = 16).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(initial(name))
        addView(column(1).apply {
            addView(label(name, 13, INK, true))
            addView(label(detail, 10, MUTED))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(10) }
        })
        addView(label(percent, 15, if (warning) WARNING else GREEN_DARK, true))
    }

    private fun roleButton(title: String, subtitle: String, dark: Boolean, click: () -> Unit) = Button(this).apply {
        text = "$title\n$subtitle                                      →"
        textSize = 15f
        isAllCaps = false
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        setPadding(dp(20), dp(8), dp(20), dp(8))
        setTextColor(if (dark) Color.WHITE else INK)
        background = shape(if (dark) DARK else Color.WHITE, 14, if (dark) DARK else LINE)
        setOnClickListener { click() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(92))
    }

    private fun infoStrip(title: String, subtitle: String) = column(2).apply {
        background = shape(PALE_GREEN, 12)
        setPadding(dp(15), dp(13), dp(15), dp(13))
        addView(label(title, 13, GREEN_DARK, true))
        addView(label(subtitle, 10, MUTED))
    }

    private fun primaryButton(text: String, click: () -> Unit) = Button(this).apply {
        this.text = text
        textSize = 14f
        isAllCaps = false
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(Color.WHITE)
        background = shape(GREEN, 12)
        setOnClickListener { click() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))
    }

    private fun outlineButton(text: String, click: () -> Unit) = Button(this).apply {
        this.text = text
        textSize = 13f
        isAllCaps = false
        setTextColor(GREEN_DARK)
        background = shape(Color.WHITE, 12, LINE)
        setOnClickListener { click() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50))
    }

    private fun smallButton(text: String, selected: Boolean, click: (Button) -> Unit) = Button(this).apply {
        this.text = text
        textSize = 11f
        isAllCaps = false
        setOnClickListener { click(this) }
        styleMiniButton(this, selected)
    }

    private fun styleMiniButton(button: Button, selected: Boolean) {
        button.setTextColor(if (selected) Color.WHITE else MUTED)
        button.background = shape(if (selected) GREEN else Color.WHITE, 10, if (selected) GREEN else LINE)
    }

    private fun chip(text: String, background: Int, foreground: Int) = label(text, 10, foreground, true).apply {
        this.background = shape(background, 30)
        setPadding(dp(12), dp(8), dp(12), dp(8))
    }

    private fun initial(name: String) = label(name.take(1), 13, GREEN_DARK, true).apply {
        gravity = Gravity.CENTER
        background = shape(PALE_GREEN, 10)
        layoutParams = LinearLayout.LayoutParams(dp(38), dp(38))
    }

    private fun card(color: Int = Color.WHITE, padding: Int = 19) = column(8).apply {
        setPadding(dp(padding), dp(padding), dp(padding), dp(padding))
        background = shape(color, 16, if (color == Color.WHITE) LINE else color)
        elevation = dp(1).toFloat()
    }

    private fun loadingMetric() = column(8).apply {
        setPadding(dp(12), dp(14), dp(12), dp(14))
        background = shape(Color.WHITE, 14, LINE)
        addView(loadingBar(45, 9))
        addView(loadingBar(62, 22).withMargins(top = 8))
    }

    private fun loadingPanel() = column(12).apply {
        setPadding(dp(18), dp(19), dp(18), dp(19))
        background = shape(Color.WHITE, 16, LINE)
        addView(loadingBar(95, 10))
        addView(loadingBar(190, 19))
        repeat(4) {
            addView(row(12).apply {
                addView(View(this@MainActivity).apply { background = shape(PALE_GREEN, 10) }, LinearLayout.LayoutParams(dp(36), dp(36)))
                addView(column(7).apply {
                    addView(loadingBar(150, 10))
                    addView(loadingBar(90, 8))
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            })
        }
    }

    private fun loadingBar(width: Int, height: Int) = View(this).apply {
        background = shape(LOADING, 8)
        layoutParams = LinearLayout.LayoutParams(dp(width), dp(height))
        alpha = 0.82f
    }

    private fun row(gap: Int = 0) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        if (gap > 0) showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
        if (gap > 0) dividerDrawable = android.graphics.drawable.ColorDrawable(Color.TRANSPARENT).apply { setBounds(0, 0, dp(gap), 1) }
    }

    private fun column(gap: Int = 0) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        if (gap > 0) showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
        if (gap > 0) dividerDrawable = android.graphics.drawable.ColorDrawable(Color.TRANSPARENT).apply { setBounds(0, 0, 1, dp(gap)) }
    }

    private fun scroll(content: View) = ScrollView(this).apply {
        setBackgroundColor(BG)
        isFillViewport = true
        addView(content)
    }

    private fun setAnimatedContent(view: View) {
        view.alpha = 0f
        view.translationY = dp(12).toFloat()
        view.scaleX = 0.992f
        view.scaleY = 0.992f
        setContentView(view)
        view.animate()
            .alpha(1f)
            .translationY(0f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(360L)
            .setInterpolator(DecelerateInterpolator(1.7f))
            .start()
    }

    private fun label(text: String, size: Int, color: Int, bold: Boolean = false) = TextView(this).apply {
        this.text = text
        textSize = size.toFloat()
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        includeFontPadding = false
    }

    private fun space(height: Int) = Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(height)) }

    private fun shape(fill: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(fill)
        cornerRadius = dp(radius).toFloat()
        stroke?.let { setStroke(dp(1), it) }
    }

    private fun View.withMargins(left: Int = 0, top: Int = 0, right: Int = 0, bottom: Int = 0): View = apply {
        layoutParams = (layoutParams as? ViewGroup.MarginLayoutParams ?: LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)).apply {
            setMargins(dp(left), dp(top), dp(right), dp(bottom))
        }
    }

    private fun findTaggedView(root: ViewGroup, tag: String): View? {
        if (root.tag == tag) return root
        for (index in 0 until root.childCount) {
            val child = root.getChildAt(index)
            if (child.tag == tag) return child
            if (child is ViewGroup) findTaggedView(child, tag)?.let { return it }
        }
        return null
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    private fun formatPercent(value: Double): String = if (value % 1.0 == 0.0) value.toInt().toString() else "%.1f".format(value)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val BG = 0xFFF8FAFC.toInt()
        const val INK = 0xFF0F172A.toInt()
        const val MUTED = 0xFF64748B.toInt()
        const val DARK = 0xFF1D4ED8.toInt()
        const val GREEN = 0xFF2563EB.toInt()
        const val GREEN_DARK = 0xFF1D4ED8.toInt()
        const val PALE_GREEN = 0xFFEFF6FF.toInt()
        const val LINE = 0xFFE2E8F0.toInt()
        const val LOADING = 0xFFE9EEF5.toInt()
        const val WARNING = 0xFFB45309.toInt()
    }
}
