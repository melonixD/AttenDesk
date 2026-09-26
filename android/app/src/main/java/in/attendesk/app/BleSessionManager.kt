package `in`.attendesk.app

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import java.util.UUID

class BleSessionManager(private val context: Context) {
    companion object {
        val SERVICE_UUID: ParcelUuid = ParcelUuid(UUID.fromString("8d53dc1d-1db7-4cd3-868b-8a527460aa84"))
    }

    private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter: BluetoothAdapter? = bluetoothManager.adapter
    private var scanCallback: ScanCallback? = null
    private val observations = linkedMapOf<String, MutableList<Int>>()

    fun requiredPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> arrayOf(Manifest.permission.BLUETOOTH_SCAN)
        else -> arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    fun hasPermissions(): Boolean = requiredPermissions().all {
        context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
    }

    @SuppressLint("MissingPermission")
    fun startStudentScan(onSignal: (NearbySignal) -> Unit, onError: (String) -> Unit) {
        stopStudentScan()
        observations.clear()
        if (!hasPermissions()) return onError("Bluetooth permission is required")
        val scanner = adapter?.bluetoothLeScanner ?: return onError("Turn Bluetooth on and try again")
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0)
            .build()
        val filters = listOf(ScanFilter.Builder().setServiceUuid(SERVICE_UUID).build())
        scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val bytes = result.scanRecord?.getServiceData(SERVICE_UUID) ?: return
                if (bytes.size != 8) return
                val token = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
                // The student app never connects to the ESP32. Samples are
                // collected directly from its rotating service advertisement.
                val samples = observations.getOrPut(token) { mutableListOf() }
                samples += result.rssi
                if (samples.size > 7) samples.removeAt(0)
                onSignal(NearbySignal(token, samples.toList()))
            }

            override fun onScanFailed(errorCode: Int) = onError("BLE scan failed (code $errorCode)")
        }.also { scanner.startScan(filters, settings, it) }
    }

    @SuppressLint("MissingPermission")
    fun stopStudentScan() {
        val callback = scanCallback ?: return
        if (hasPermissions()) adapter?.bluetoothLeScanner?.stopScan(callback)
        scanCallback = null
    }

    fun close() {
        stopStudentScan()
    }
}
