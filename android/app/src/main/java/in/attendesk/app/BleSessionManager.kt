package `in`.attendesk.app

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
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

    private val adapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private var advertiseCallback: AdvertiseCallback? = null
    private var scanCallback: ScanCallback? = null
    private val observations = linkedMapOf<String, MutableList<Int>>()

    fun requiredPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> arrayOf(
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT
        )
        else -> arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    fun hasPermissions(): Boolean = requiredPermissions().all {
        context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
    }

    @SuppressLint("MissingPermission")
    fun startTeacherBroadcast(tokenHex: String, onStarted: () -> Unit, onError: (String) -> Unit) {
        stopTeacherBroadcast()
        if (!hasPermissions()) return onError("Bluetooth permission is required")
        if (adapter?.isEnabled != true) return onError("Turn Bluetooth on first")
        val advertiser = adapter.bluetoothLeAdvertiser ?: return onError("This phone cannot broadcast BLE advertisements")
        val token = runCatching { tokenHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray() }
            .getOrElse { return onError("Invalid attendance token") }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(false)
            .setTimeout(0)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceData(SERVICE_UUID, token)
            .build()
        advertiseCallback = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) = onStarted()
            override fun onStartFailure(errorCode: Int) = onError("BLE broadcast failed (code $errorCode)")
        }.also { advertiser.startAdvertising(settings, data, it) }
    }

    @SuppressLint("MissingPermission")
    fun stopTeacherBroadcast() {
        val callback = advertiseCallback ?: return
        if (hasPermissions()) adapter?.bluetoothLeAdvertiser?.stopAdvertising(callback)
        advertiseCallback = null
    }

    @SuppressLint("MissingPermission")
    fun startStudentScan(onSignal: (NearbySignal) -> Unit, onError: (String) -> Unit) {
        stopStudentScan()
        observations.clear()
        if (!hasPermissions()) return onError("Bluetooth permission is required")
        if (adapter?.isEnabled != true) return onError("Turn Bluetooth on first")
        val scanner = adapter.bluetoothLeScanner ?: return onError("BLE scanning is unavailable")
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0)
            .build()
        scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val bytes = result.scanRecord?.getServiceData(SERVICE_UUID) ?: return
                if (bytes.size != 8) return
                val token = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
                val samples = observations.getOrPut(token) { mutableListOf() }
                samples += result.rssi
                if (samples.size > 7) samples.removeAt(0)
                onSignal(NearbySignal(token, samples.toList()))
            }

            override fun onScanFailed(errorCode: Int) = onError("BLE scan failed (code $errorCode)")
        }.also { scanner.startScan(null, settings, it) }
    }

    @SuppressLint("MissingPermission")
    fun stopStudentScan() {
        val callback = scanCallback ?: return
        if (hasPermissions()) adapter?.bluetoothLeScanner?.stopScan(callback)
        scanCallback = null
    }

    fun close() {
        stopTeacherBroadcast()
        stopStudentScan()
    }
}
