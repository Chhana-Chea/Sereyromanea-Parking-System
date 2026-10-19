#include <Arduino.h>
#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>

#include "board_config.h"

const char *ssid = "Edgar";
const char *password = "123456789";

WebServer webServer(80);
WiFiServer streamServer(81);

bool initCamera()
{
  camera_config_t config = {};

  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;

  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound())
  {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 10;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;
  }
  else
  {
    config.frame_size = FRAMESIZE_QVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }

  esp_err_t error = esp_camera_init(&config);

  if (error != ESP_OK)
  {
    Serial.printf("Camera init failed with error 0x%x\n", error);
    return false;
  }

  sensor_t *sensor = esp_camera_sensor_get();

  if (sensor)
  {
    if (sensor->id.PID == OV3660_PID)
    {
      sensor->set_vflip(sensor, 1);
      sensor->set_brightness(sensor, 1);
      sensor->set_saturation(sensor, -2);
    }

    sensor->set_framesize(sensor, psramFound() ? FRAMESIZE_VGA : FRAMESIZE_QVGA);
  }

  Serial.println("Camera initialized successfully.");
  return true;
}

void handleRoot()
{
  String html = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MotorPark ESP32-CAM</title>
<style>
body { margin: 0; padding: 20px; background: #111; color: white; font-family: Arial, sans-serif; text-align: center; }
h1 { margin-bottom: 10px; }
img { width: 100%; max-width: 800px; border-radius: 10px; background: black; }
button { margin-top: 20px; padding: 14px 25px; border: 0; border-radius: 8px; background: #15966b; color: white; font-size: 16px; cursor: pointer; }
</style>
</head>
<body>
<h1>MotorPark ESP32-CAM</h1>
<p>Live Camera</p>
<img src="http://%CAMERA_IP%:81/stream">
<br>
<button onclick="capture()">Capture Driver + Motorcycle</button>
<script>
function capture() { window.open('/capture', '_blank'); }
</script>
</body>
</html>
)rawliteral";

  html.replace("%CAMERA_IP%", WiFi.localIP().toString());
  webServer.send(200, "text/html", html);
}

void handleCapture()
{
  camera_fb_t *frame = esp_camera_fb_get();

  if (!frame)
  {
    webServer.send(500, "text/plain", "Camera capture failed");
    return;
  }

  WiFiClient client = webServer.client();
  webServer.sendHeader("Content-Type", "image/jpeg");
  webServer.sendHeader("Content-Length", String(frame->len));
  webServer.send(200);
  client.write(frame->buf, frame->len);
  esp_camera_fb_return(frame);
}

void handleStatus()
{
  String json = "{\"camera\":\"connected\",\"wifi\":\"connected\",\"ip\":\"";
  json += WiFi.localIP().toString();
  json += "\"}";
  webServer.send(200, "application/json", json);
}

void startWebServer()
{
  webServer.on("/", HTTP_GET, handleRoot);
  webServer.on("/capture", HTTP_GET, handleCapture);
  webServer.on("/status", HTTP_GET, handleStatus);
  webServer.begin();
  Serial.println("Web server started on port 80");
}

void streamCamera()
{
  WiFiClient client = streamServer.available();

  if (!client)
  {
    return;
  }

  Serial.println("Camera stream client connected.");

  unsigned long timeout = millis();

  while (!client.available() && millis() - timeout < 2000)
  {
    delay(1);
  }

  if (!client.available())
  {
    client.stop();
    return;
  }

  while (client.available())
  {
    client.read();
  }

  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: multipart/x-mixed-replace; boundary=frame");
  client.println("Cache-Control: no-cache");
  client.println("Access-Control-Allow-Origin: *");
  client.println();

  while (client.connected())
  {
    camera_fb_t *frame = esp_camera_fb_get();

    if (!frame)
    {
      Serial.println("Camera frame failed.");
      delay(100);
      continue;
    }

    client.println("--frame");
    client.println("Content-Type: image/jpeg");
    client.print("Content-Length: ");
    client.println(frame->len);
    client.println();

    size_t written = 0;

    while (written < frame->len && client.connected())
    {
      size_t chunk = min((size_t)1024, frame->len - written);
      size_t result = client.write(frame->buf + written, chunk);

      if (result == 0)
      {
        break;
      }

      written += result;
    }

    client.println();
    esp_camera_fb_return(frame);

    if (!client.connected())
    {
      break;
    }

    delay(30);
  }

  client.stop();
  Serial.println("Camera stream client disconnected.");
}

void setup()
{
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("=================================");
  Serial.println("      MotorPark ESP32-CAM");
  Serial.println("=================================");

  if (!initCamera())
  {
    Serial.println("CAMERA INITIALIZATION FAILED");

    while (true)
    {
      delay(1000);
    }
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");

  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi connected!");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  startWebServer();
  streamServer.begin();
  Serial.println("Stream server started on port 81");
  Serial.println();
  Serial.println("=================================");
  Serial.print("Camera page: http://");
  Serial.println(WiFi.localIP());
  Serial.print("Live stream: http://");
  Serial.print(WiFi.localIP());
  Serial.println(":81/stream");
  Serial.print("Capture:     http://");
  Serial.print(WiFi.localIP());
  Serial.println("/capture");
  Serial.println("=================================");
}

void loop()
{
  webServer.handleClient();
  streamCamera();
  delay(1);
}
