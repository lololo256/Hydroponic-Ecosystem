#pragma once

// Copy this file to secrets.h (secrets.h is git-ignored - NEVER commit it).

// ThingsBoard device access token (one token PER BOARD - never share a token between boards)
#define DEFAULT_TB_TOKEN "YOUR_THINGSBOARD_DEVICE_TOKEN"
#define DEFAULT_TB_SERVER "eu.thingsboard.cloud"

// Device name exactly as it is in ThingsBoard (also the BLE name and the QR "d" field).
// Leave as "YOUR_..." (or "") to use FARM-<last 6 hex of the MAC> automatically.
#define DEFAULT_DEVICE_ID "YOUR_TB_DEVICE_NAME"
