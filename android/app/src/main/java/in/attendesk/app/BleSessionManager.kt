package `in`.attendesk.app

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
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
        val TOKEN_CHARACTERISTIC_UUID: UUID = UUID.fromString("d953c2d0-34d8-4d7b-94a7-2f54b42ea6d1")
    }

    private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter: BluetoothAdapter? = bluetoothManager.adapter
    private var advertiseCallback: AdvertiseCallback? = null
    private var gattServer: BluetoothGattServer? = null
    private var advertisedToken: ByteArray? = null
    private var originalAdapterName: String? = null
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
    fun startTeacherBroadcast(tokenHex: String, roomLabel: String, onStarted: () -> Unit, onError: (String) -> Unit) {
        stopTeacherBroadcast()
        if (!hasPermissions()) return onError("Bluetooth permission is required")
        if (adapter?.isEnabled != true) return onError("Turn Bluetooth on first")
        val advertiser = adapter.bluetoothLeAdvertiser ?: return onError("This phone cannot broadcast BLE advertisements")
        val token = runCatching { tokenHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray() }
            .getOrElse { return onError("Invalid attendance token") }
        advertisedToken = token
        originalAdapterName = adapter.name
        adapter.name = "AttenDesk ${roomLabel.take(12)}"
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceData(SERVICE_UUID, token)
            .build()
        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(true)
            .build()
        val callback = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) = onStarted()
            override fun onStartFailure(errorCode: Int) {
                stopTeacherBroadcast()
                onError("BLE broadcast failed (code $errorCode)")
            }
        }
        advertiseCallback = callback

        val serverCallback = object : BluetoothGattServerCallback() {
            override fun onServiceAdded(status: Int, service: BluetoothGattService?) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    stopTeacherBroadcast()
                    return onError("Bluetooth classroom service could not start (code $status)")
                }
                advertiser.startAdvertising(settings, data, scanResponse, callback)
            }

            override fun onCharacteristicReadRequest(
                device: BluetoothDevice?, requestId: Int, offset: Int,
                characteristic: BluetoothGattCharacteristic?
            ) {
                if (characteristic?.uuid != TOKEN_CHARACTERISTIC_UUID || device == null) return
                val value = advertisedToken ?: byteArrayOf()
                if (offset > value.size) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
                } else {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value.copyOfRange(offset, value.size))
                }
            }
        }
        val server = bluetoothManager.openGattServer(context, serverCallback) ?: run {
            stopTeacherBroadcast()
            return onError("This phone cannot host the classroom Bluetooth service")
        }
        gattServer = server
        val service = BluetoothGattService(SERVICE_UUID.uuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(BluetoothGattCharacteristic(
            TOKEN_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_READ,
            BluetoothGattCharacteristic.PERMISSION_READ
        ))
        if (!server.addService(service)) {
            stopTeacherBroadcast()
            onError("Bluetooth classroom service could not be registered")
        }
    }

    @SuppressLint("MissingPermission")
    fun stopTeacherBroadcast() {
        val callback = advertiseCallback
        if (callback != null && hasPermissions()) adapter?.bluetoothLeAdvertiser?.stopAdvertising(callback)
        advertiseCallback = null
        gattServer?.clearServices()
        gattServer?.close()
        gattServer = null
        advertisedToken = null
        originalAdapterName?.let { adapter?.name = it }
        originalAdapterName = null
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
                // Keyed by device, not by code: the ESP32 rotates its code every
                // 30 seconds and the signal history must survive that.
                val samples = observations.getOrPut(result.device.address) { mutableListOf() }
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
