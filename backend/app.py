import base64
import io
import json
import os
import re
import socket
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import psycopg2
import requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory, session, stream_with_context
from flask_cors import CORS

ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT_DIR / "frontend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

try:
    from auth import auth_bp, initialize_auth_database
except ImportError:
    from backend.auth import auth_bp, initialize_auth_database

# Where captured driver/motorcycle/plate images are stored on disk.
UPLOADS_DIR = ROOT_DIR / "uploads" / "parking"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# Load backend/.env
load_dotenv(BACKEND_DIR / ".env")


# ============================================================
# ESP32-CAM CONFIG
# ============================================================
CAMERA_CONFIG_FILE = BACKEND_DIR / "camera_config.json"
DEFAULT_ESP32_IP = os.getenv("ESP32_CAM_IP", "172.20.10.12")


def get_camera_ip():
    if CAMERA_CONFIG_FILE.exists():
        try:
            data = json.loads(CAMERA_CONFIG_FILE.read_text())
            ip = str(data.get("esp32_ip", "")).strip()
            if ip:
                return ip
        except Exception:
            pass
    return DEFAULT_ESP32_IP


def save_camera_ip(ip):
    CAMERA_CONFIG_FILE.write_text(
        json.dumps({"esp32_ip": str(ip).strip()})
    )


def get_local_lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


remote_scan_events = []
remote_scan_lock = threading.Lock()
remote_scan_counter = 0


# ============================================================
# FLASK APPLICATION
# ============================================================

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "motorpark_secret_key_default_3819")
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

CORS(
    app,
    origins=os.getenv("FRONTEND_ORIGIN", "*"),
    supports_credentials=True
)

app.register_blueprint(auth_bp)


# ============================================================
# DATABASE CONNECTION (PostgreSQL)
# ============================================================

def get_connection():
    """Connect to PostgreSQL database."""
    dbname = os.getenv("PGDATABASE", "MotorPark")
    port = int(os.getenv("PGPORT", "5432"))
    host = os.getenv("PGHOST", "127.0.0.1")
    user = os.getenv("PGUSER", "postgres")
    password = os.getenv("PGPASSWORD", "123456789")
    try:
        return psycopg2.connect(
            host=host,
            port=port,
            dbname=dbname,
            user=user,
            password=password,
            connect_timeout=5
        )
    except psycopg2.OperationalError as e:
        alt_db = "motorpark" if dbname == "MotorPark" else "MotorPark"
        try:
            return psycopg2.connect(
                host=host,
                port=port,
                dbname=alt_db,
                user=user,
                password=password,
                connect_timeout=5
            )
        except Exception:
            raise e


# ============================================================
# DATABASE INITIALIZATION & MIGRATION
# ============================================================

def generate_strong_numeric_id(cursor):
    """Generate a strong unique numeric ID (8 digits, numbers only)."""
    import secrets
    for _ in range(100):
        cand = str(secrets.randbelow(90000000) + 10000000)
        cursor.execute("SELECT 1 FROM motorcycles WHERE moto_id = %s", (cand,))
        if not cursor.fetchone():
            return cand
    return str(int(time.time() * 1000))[-8:]


def initialize_database():
    """Create required PostgreSQL tables and migrate existing data if needed."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            # 1. Initialize authentication tables (managers, staff)
            initialize_auth_database(conn)

            # 2. Motorcycles Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS motorcycles (
                    id SERIAL PRIMARY KEY,
                    moto_id VARCHAR(50) UNIQUE,
                    plate_number VARCHAR(50),
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            """)

            # 3. Parking Spaces Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS parking_spaces (
                    id SERIAL PRIMARY KEY,
                    space_number VARCHAR(10) NOT NULL UNIQUE,
                    status VARCHAR(20) NOT NULL DEFAULT 'available'
                );
            """)

            # 4. Check if parking_records table exists
            cursor.execute("""
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'parking_records';
            """)
            has_records_table = cursor.fetchone() is not None

            if not has_records_table:
                cursor.execute("""
                    CREATE TABLE parking_records (
                        id SERIAL PRIMARY KEY,
                        record_id VARCHAR(30) UNIQUE,
                        moto_id VARCHAR(50),
                        motorcycle_id INT NOT NULL REFERENCES motorcycles(id) ON DELETE CASCADE,
                        staff_id INT REFERENCES staff(id) ON DELETE SET NULL,
                        space_number VARCHAR(10) REFERENCES parking_spaces(space_number) ON DELETE SET NULL,
                        entry_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        exit_time TIMESTAMP,
                        duration_minutes INT,
                        parking_fee INT DEFAULT 0,
                        payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
                        status VARCHAR(30) NOT NULL DEFAULT 'PARKED',
                        verification VARCHAR(30) DEFAULT 'NOT VERIFIED',
                        driver_image VARCHAR(255),
                        motorcycle_image VARCHAR(255),
                        plate_image VARCHAR(255),
                        exit_image VARCHAR(255)
                    );
                """)
            else:
                # Existing table: inspect existing columns and migrate cleanly
                cursor.execute("""
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'parking_records';
                """)
                existing_cols = {row[0] for row in cursor.fetchall()}

                # Add motorcycle_id column if not present
                if "motorcycle_id" not in existing_cols:
                    cursor.execute("""
                        ALTER TABLE parking_records 
                        ADD COLUMN motorcycle_id INT REFERENCES motorcycles(id) ON DELETE CASCADE;
                    """)

                # Add staff_id column if not present
                if "staff_id" not in existing_cols:
                    cursor.execute("""
                        ALTER TABLE parking_records 
                        ADD COLUMN staff_id INT REFERENCES staff(id) ON DELETE SET NULL;
                    """)
                    cursor.execute("""
                        UPDATE parking_records
                        SET staff_id = (SELECT id FROM staff ORDER BY id LIMIT 1)
                        WHERE staff_id IS NULL;
                    """)

                # Add manager_id column if not present
                if "manager_id" not in existing_cols:
                    cursor.execute("""
                        ALTER TABLE parking_records 
                        ADD COLUMN manager_id INT REFERENCES managers(id) ON DELETE SET NULL;
                    """)
                    cursor.execute("""
                        UPDATE parking_records
                        SET manager_id = (SELECT id FROM managers ORDER BY id LIMIT 1)
                        WHERE manager_id IS NULL;
                    """)

                # Add entry_time column if not present
                if "entry_time" not in existing_cols:
                    cursor.execute("""
                        ALTER TABLE parking_records 
                        ADD COLUMN entry_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
                    """)
                    if "arrival_time" in existing_cols:
                        cursor.execute("""
                            UPDATE parking_records 
                            SET entry_time = arrival_time 
                            WHERE entry_time IS NULL;
                        """)

                # Add parking_fee column if not present
                if "parking_fee" not in existing_cols:
                    cursor.execute("""
                        ALTER TABLE parking_records 
                        ADD COLUMN parking_fee INT DEFAULT 0;
                    """)
                    if "fee" in existing_cols:
                        cursor.execute("""
                            UPDATE parking_records 
                            SET parking_fee = fee 
                            WHERE parking_fee IS NULL;
                        """)

                # Add payment_status column if not present
                if "payment_status" not in existing_cols:
                    cursor.execute("""
                        ALTER TABLE parking_records 
                        ADD COLUMN payment_status VARCHAR(30) DEFAULT 'UNPAID';
                    """)
                    cursor.execute("""
                        UPDATE parking_records
                        SET payment_status = CASE WHEN status = 'COMPLETED' THEN 'PAID' ELSE 'UNPAID' END
                        WHERE payment_status IS NULL;
                    """)

                # Add exit_image column if not present
                if "exit_image" not in existing_cols:
                    cursor.execute("""
                        ALTER TABLE parking_records 
                        ADD COLUMN exit_image VARCHAR(255);
                    """)

                # Make legacy columns nullable if they exist so new schema operates freely
                if "plate" in existing_cols:
                    cursor.execute("ALTER TABLE parking_records ALTER COLUMN plate DROP NOT NULL;")
                if "arrival_time" in existing_cols:
                    cursor.execute("ALTER TABLE parking_records ALTER COLUMN arrival_time DROP NOT NULL;")

            # Ensure motorcycles has moto_id and plate_number is nullable
            cursor.execute("ALTER TABLE motorcycles ADD COLUMN IF NOT EXISTS moto_id VARCHAR(50);")
            cursor.execute("ALTER TABLE motorcycles ALTER COLUMN plate_number DROP NOT NULL;")
            cursor.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint WHERE conname = 'motorcycles_moto_id_unique'
                    ) THEN
                        BEGIN
                            ALTER TABLE motorcycles ADD CONSTRAINT motorcycles_moto_id_unique UNIQUE (moto_id);
                        EXCEPTION WHEN OTHERS THEN
                            NULL;
                        END;
                    END IF;
                END $$;
            """)

            # Ensure parking_records has moto_id
            cursor.execute("ALTER TABLE parking_records ADD COLUMN IF NOT EXISTS moto_id VARCHAR(50);")
            cursor.execute("ALTER TABLE parking_records ADD COLUMN IF NOT EXISTS plate VARCHAR(50);")
            cursor.execute("ALTER TABLE parking_records ALTER COLUMN plate DROP NOT NULL;")
            cursor.execute("ALTER TABLE parking_records ADD COLUMN IF NOT EXISTS arrival_time TIMESTAMP;")
            cursor.execute("ALTER TABLE parking_records ADD COLUMN IF NOT EXISTS fee INT DEFAULT 0;")
            cursor.execute("ALTER TABLE parking_records ADD COLUMN IF NOT EXISTS exit_image VARCHAR(255);")

            # Backfill any null moto_id in motorcycles with strong numeric IDs
            cursor.execute("SELECT id FROM motorcycles WHERE moto_id IS NULL OR moto_id = '';")
            m_rows = cursor.fetchall()
            for row in m_rows:
                m_id = row[0]
                strong_num = f"{80000000 + m_id}"
                cursor.execute("UPDATE motorcycles SET moto_id = %s WHERE id = %s;", (strong_num, m_id))

            # Sync moto_id to parking_records
            cursor.execute("""
                UPDATE parking_records pr
                SET moto_id = m.moto_id
                FROM motorcycles m
                WHERE pr.motorcycle_id = m.id AND (pr.moto_id IS NULL OR pr.moto_id = '');
            """)

            # Ensure all parking records reference the cashier staff and default manager
            cursor.execute("""
                UPDATE parking_records
                SET staff_id = (SELECT id FROM staff WHERE username = 'cashier' LIMIT 1)
                WHERE staff_id IS NULL OR staff_id NOT IN (SELECT id FROM staff);
            """)
            cursor.execute("""
                UPDATE parking_records
                SET manager_id = (SELECT id FROM managers WHERE username = 'admin' LIMIT 1)
                WHERE manager_id IS NULL OR manager_id NOT IN (SELECT id FROM managers);
            """)

            # 5. Populate parking spaces (001 to 500)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_spaces_status ON parking_spaces(status);")
            spaces = [(f"{i:03d}", "available") for i in range(1, 501)]
            cursor.executemany(
                "INSERT INTO parking_spaces (space_number, status) VALUES (%s, %s) ON CONFLICT (space_number) DO NOTHING;",
                spaces
            )

            conn.commit()
    finally:
        conn.close()


# ============================================================
# CONVERT SQL ROW TO JSON
# ============================================================

def row_to_dict(cursor, row):
    if not row:
        return None

    columns = [column[0] for column in cursor.description]
    result = dict(zip(columns, row))

    for key, value in result.items():
        if isinstance(value, datetime):
            result[key] = value.isoformat(timespec="seconds")

    return result


# ============================================================
# IMAGE CAPTURE STORAGE
# ============================================================

DATA_URL_PATTERN = re.compile(r"^data:image/\w+;base64,(.+)$", re.DOTALL)


def save_capture_image(record_id, kind, data_url):
    """
    Decode a base64 image data URL and save it under
    uploads/parking/<record_id>/<kind>.jpg.
    """
    if not data_url or not isinstance(data_url, str):
        return None

    match = DATA_URL_PATTERN.match(data_url.strip())
    raw_base64 = match.group(1) if match else data_url.strip()

    try:
        image_bytes = base64.b64decode(raw_base64, validate=False)
    except Exception:
        return None

    if not image_bytes:
        return None

    record_folder = UPLOADS_DIR / record_id
    record_folder.mkdir(parents=True, exist_ok=True)

    file_path = record_folder / f"{kind}.jpg"
    file_path.write_bytes(image_bytes)

    return f"uploads/parking/{record_id}/{kind}.jpg"


@app.get("/uploads/parking/<path:subpath>")
def serve_capture_image(subpath):
    """Serve a stored driver/motorcycle/plate capture image."""
    return send_from_directory(UPLOADS_DIR, subpath)


@app.get("/api/camera-config")
def get_camera_config():
    return jsonify({
        "esp32_ip": get_camera_ip()
    })


@app.post("/api/camera-config")
def update_camera_config():
    data = request.get_json(silent=True) or {}
    ip = str(data.get("esp32_ip", "")).strip()

    if not ip:
        return jsonify({"error": "esp32_ip is required"}), 400

    save_camera_ip(ip)

    return jsonify({
        "esp32_ip": ip
    })


# ============================================================
# LIVE CAMERA FRAME BUFFER & CACHE (SHARED ESP32 STREAMER)
# ============================================================

_latest_camera_frame = None
_latest_frame_time = 0
_frame_condition = threading.Condition()
_streamer_thread = None
_streamer_lock = threading.Lock()


def generate_camera_standby_frame(ip, status="STANDBY"):
    """Generate a crisp, modern, themed standby frame when ESP32 camera is offline/connecting."""
    try:
        from PIL import Image, ImageDraw
        width, height = 640, 480
        img = Image.new("RGB", (width, height), color=(14, 20, 30))
        draw = ImageDraw.Draw(img)

        draw.rectangle([(16, 16), (width - 16, height - 16)], outline=(35, 48, 68), width=2)
        corner_len = 24
        for x, y, dx, dy in [
            (16, 16, 1, 1),
            (width - 16, 16, -1, 1),
            (16, height - 16, 1, -1),
            (width - 16, height - 16, -1, -1)
        ]:
            draw.line([(x, y), (x + dx * corner_len, y)], fill=(255, 122, 89), width=3)
            draw.line([(x, y), (x, y + dy * corner_len)], fill=(255, 122, 89), width=3)

        draw.text((32, 28), "SEREYROMANEA BUILDING", fill=(255, 255, 255))
        draw.text((32, 46), "GATE CAM STREAM // LIVE PROXY", fill=(143, 160, 181))

        cx, cy = width // 2, height // 2 - 20
        draw.ellipse([(cx - 50, cy - 50), (cx + 50, cy + 50)], outline=(45, 62, 86), width=3)
        draw.ellipse([(cx - 30, cy - 30), (cx + 30, cy + 30)], outline=(255, 122, 89), width=2)
        draw.ellipse([(cx - 10, cy - 10), (cx + 10, cy + 10)], fill=(255, 122, 89))

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        draw.text((width - 200, 28), now_str, fill=(143, 160, 181))

        status_label = f"ESP32-CAM: {status} ({ip})"
        draw.text((cx - 130, cy + 70), status_label, fill=(255, 180, 100))
        draw.text((cx - 160, cy + 96), "Standby feed active • Ready for live capture", fill=(100, 125, 155))

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return buf.getvalue()
    except Exception:
        return b"\xff\xd8\xff\xd9"


def set_cached_frame(raw_bytes):
    global _latest_camera_frame, _latest_frame_time
    if raw_bytes and len(raw_bytes) > 500:
        with _frame_condition:
            _latest_camera_frame = raw_bytes
            _latest_frame_time = time.time()
            _frame_condition.notify_all()


def get_cached_frame(max_age=15.0):
    with _frame_condition:
        if _latest_camera_frame and (time.time() - _latest_frame_time < max_age):
            return _latest_camera_frame
    return None


def _esp32_stream_worker():
    """Single shared background thread that pulls from ESP32-CAM to prevent socket collisions."""
    global _latest_camera_frame, _latest_frame_time
    while True:
        ip = get_camera_ip()
        stream_url = f"http://{ip}:81/stream"
        buf = bytearray()
        try:
            with requests.get(stream_url, stream=True, timeout=8) as stream_resp:
                if stream_resp.status_code == 200:
                    for chunk in stream_resp.iter_content(chunk_size=4096):
                        if not chunk:
                            continue
                        buf.extend(chunk)
                        start = buf.find(b"\xff\xd8")
                        end = buf.find(b"\xff\xd9", start + 2) if start != -1 else -1
                        if start != -1 and end != -1:
                            frame = bytes(buf[start:end + 2])
                            with _frame_condition:
                                _latest_camera_frame = frame
                                _latest_frame_time = time.time()
                                _frame_condition.notify_all()
                            buf = buf[end + 2:]
                        elif len(buf) > 400000:
                            buf.clear()
        except Exception:
            # Fallback: if port 81 dropped or busy, poll port 80 /capture
            try:
                r = requests.get(f"http://{ip}/capture", timeout=1.5)
                if r.status_code == 200 and len(r.content) > 500:
                    with _frame_condition:
                        _latest_camera_frame = r.content
                        _latest_frame_time = time.time()
                        _frame_condition.notify_all()
                    time.sleep(0.08)
                    continue
            except Exception:
                pass
            time.sleep(1.5)


def ensure_stream_worker_running():
    global _streamer_thread
    with _streamer_lock:
        if _streamer_thread is None or not _streamer_thread.is_alive():
            _streamer_thread = threading.Thread(target=_esp32_stream_worker, daemon=True)
            _streamer_thread.start()


@app.get("/api/camera/snapshot")
def camera_snapshot():
    """Return a base64 encoded snapshot from the live camera with CORS headers."""
    ensure_stream_worker_running()
    # 1. Fresh frame from shared stream cache
    cached = get_cached_frame(max_age=3.5)
    if cached:
        encoded = base64.b64encode(cached).decode("ascii")
        resp = jsonify({
            "success": True,
            "image": f"data:image/jpeg;base64,{encoded}",
            "source": "stream_cache"
        })
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp

    ip = get_camera_ip()
    capture_url = f"http://{ip}/capture"

    # 2. Try direct capture from camera
    try:
        response = requests.get(capture_url, timeout=1.2)
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "image/jpeg")

        if "image" not in content_type:
            raise ValueError("Camera did not return an image")

        frame_bytes = response.content
        set_cached_frame(frame_bytes)
        encoded = base64.b64encode(frame_bytes).decode("ascii")

        resp = jsonify({
            "success": True,
            "image": f"data:{content_type};base64,{encoded}",
            "source": "direct_capture"
        })
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp
    except Exception as error:
        fallback = get_cached_frame(max_age=60.0)
        if fallback:
            encoded = base64.b64encode(fallback).decode("ascii")
            resp = jsonify({
                "success": True,
                "image": f"data:image/jpeg;base64,{encoded}",
                "source": "fallback_cache"
            })
            resp.headers["Access-Control-Allow-Origin"] = "*"
            return resp

        # Resilient fallback: return standby frame instead of failing with 502
        standby_bytes = generate_camera_standby_frame(ip, "STANDBY")
        encoded = base64.b64encode(standby_bytes).decode("ascii")
        resp = jsonify({
            "success": True,
            "image": f"data:image/jpeg;base64,{encoded}",
            "source": "standby_frame",
            "warning": f"Could not reach camera at {ip}: {error}"
        })
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp


@app.get("/api/camera/stream")
def camera_stream():
    """Broadcast live MJPEG video stream to any number of browser clients simultaneously."""
    ensure_stream_worker_running()

    def generate():
        last_time = 0
        last_standby_time = 0

        while True:
            ip = get_camera_ip()
            with _frame_condition:
                _frame_condition.wait(timeout=0.6)
                frame = _latest_camera_frame
                t = _latest_frame_time

            now = time.time()
            # If fresh frame from physical camera received in last 3.5 seconds
            if frame and (now - t < 3.5):
                if t != last_time:
                    last_time = t
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
                    )
            else:
                # Camera is connecting or offline: yield standby frame every 0.9s
                if now - last_standby_time >= 0.9:
                    last_standby_time = now
                    standby_bytes = generate_camera_standby_frame(ip, "CONNECTING / STANDBY")
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n" + standby_bytes + b"\r\n"
                    )

    return Response(
        stream_with_context(generate()),
        mimetype="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Access-Control-Allow-Origin": "*"
        }
    )


@app.get("/api/camera/capture")
def camera_capture_raw():
    """Return raw JPEG frame directly from ESP32-CAM or cache."""
    cached = get_cached_frame(max_age=3.0)
    if cached:
        return Response(cached, mimetype="image/jpeg")

    ip = get_camera_ip()
    capture_url = f"http://{ip}/capture"

    try:
        response = requests.get(capture_url, timeout=1.2)
        response.raise_for_status()
        set_cached_frame(response.content)
        return Response(response.content, mimetype=response.headers.get("Content-Type", "image/jpeg"))
    except Exception:
        fallback = get_cached_frame(max_age=60.0)
        if fallback:
            return Response(fallback, mimetype="image/jpeg")
        standby = generate_camera_standby_frame(ip, "STANDBY")
        return Response(standby, mimetype="image/jpeg")


@app.get("/api/camera/status")
def camera_status():
    """Check connection status to ESP32-CAM and return diagnostics."""
    ip = get_camera_ip()
    status_info = {
        "esp32_ip": ip,
        "stream_url": "/api/camera/stream",
        "direct_stream_url": f"http://{ip}:81/stream",
        "connected": False,
        "latency_ms": None,
        "cached": False,
        "error": None
    }

    cached = get_cached_frame(max_age=4.0)
    if cached:
        status_info["connected"] = True
        status_info["cached"] = True
        status_info["latency_ms"] = 5
        return jsonify(status_info)

    t0 = datetime.now()
    try:
        resp = requests.get(f"http://{ip}/capture", timeout=1.2)
        if resp.status_code == 200:
            set_cached_frame(resp.content)
            status_info["connected"] = True
            status_info["latency_ms"] = round((datetime.now() - t0).total_seconds() * 1000)
    except Exception as e:
        status_info["error"] = str(e)

    return jsonify(status_info)


@app.get("/api/camera/scan-network")
def scan_camera_network():
    """Scan local network subnets to auto-detect ESP32-CAM device IP."""
    from concurrent.futures import ThreadPoolExecutor

    detected_ips = []
    current_configured_ip = get_camera_ip()

    subnets_to_scan = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            local_ip = info[4][0]
            if not local_ip.startswith("127."):
                prefix = ".".join(local_ip.split(".")[:3]) + "."
                subnets_to_scan.add(prefix)
    except Exception:
        pass

    subnets_to_scan.add("192.168.1.")
    subnets_to_scan.add("172.20.10.")

    def check_candidate(candidate_ip):
        for port in [81, 80]:
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(0.3)
                res = s.connect_ex((candidate_ip, port))
                s.close()
                if res == 0:
                    try:
                        r = requests.get(f"http://{candidate_ip}/status", timeout=0.8)
                        if r.status_code == 200:
                            detected_ips.append({"ip": candidate_ip, "port": port, "type": "ESP32-CAM"})
                            return
                    except Exception:
                        pass
                    detected_ips.append({"ip": candidate_ip, "port": port, "type": "HTTP Device"})
                    return
            except Exception:
                pass

    ips_to_check = []
    if current_configured_ip:
        ips_to_check.append(current_configured_ip)

    for prefix in subnets_to_scan:
        for i in range(1, 40):
            ips_to_check.append(f"{prefix}{i}")

    # Deduplicate IPs
    ips_to_check = list(dict.fromkeys(ips_to_check))

    with ThreadPoolExecutor(max_workers=30) as executor:
        executor.map(check_candidate, ips_to_check)

    # Deduplicate detected IPs
    unique_detected = []
    seen_ips = set()
    for d in detected_ips:
        if d["ip"] not in seen_ips:
            seen_ips.add(d["ip"])
            unique_detected.append(d)

    auto_saved = False
    if unique_detected:
        first_ip = unique_detected[0]["ip"]
        save_camera_ip(first_ip)
        auto_saved = True

    return jsonify({
        "success": True,
        "detected": unique_detected,
        "configured_ip": get_camera_ip(),
        "auto_saved": auto_saved
    })


# ============================================================
# FRONTEND STATIC ROUTES
# ============================================================

@app.get("/")
@app.get("/kiosk")
@app.get("/management")
@app.get("/staff")
@app.get("/admin")
def frontend():
    resp = send_from_directory(FRONTEND_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.get("/ticket/<path:ticket_id>")
@app.get("/t/<path:ticket_id>")
def view_ticket_mobile(ticket_id):
    resp = send_from_directory(FRONTEND_DIR, "ticket.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.get("/mobile-scanner")
def view_mobile_scanner():
    resp = send_from_directory(FRONTEND_DIR, "mobile_scanner.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.get("/style.css")
def style_css():
    resp = send_from_directory(FRONTEND_DIR, "style.css")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.get("/script.js")
def script_js():
    resp = send_from_directory(FRONTEND_DIR, "script.js")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.get("/zxing.min.js")
def zxing_js():
    resp = send_from_directory(FRONTEND_DIR, "zxing.min.js")
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.get("/<path:filename>")
def static_file(filename):
    target = FRONTEND_DIR / filename
    if target.exists() and target.is_file():
        resp = send_from_directory(FRONTEND_DIR, filename)
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return resp
    return jsonify({"error": f"File {filename} not found"}), 404


# ============================================================
# HEALTH CHECK
# ============================================================

@app.get("/api/health")
def health():
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM motorcycles;")
            m_count = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM parking_records;")
            r_count = cursor.fetchone()[0]
        conn.close()
        return jsonify({
            "status": "ok",
            "database": "connected (PostgreSQL)",
            "service": "Sereyromanea Building Parking",
            "motorcycles_count": m_count,
            "records_count": r_count
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "database": "not connected",
            "error": str(e)
        }), 500


# ============================================================
# SERVER INFO & REMOTE PHONE SCAN BRIDGE
# ============================================================

@app.get("/api/server-info")
def server_info():
    lan_ip = get_local_lan_ip()
    port = int(os.getenv("PORT", 5000))
    return jsonify({
        "local_ip": lan_ip,
        "port": port,
        "base_url": f"http://{lan_ip}:{port}"
    })


@app.post("/api/remote-scan")
def trigger_remote_scan():
    global remote_scan_counter
    data = request.get_json(silent=True) or {}
    ticket_id = str(data.get("ticket_id") or data.get("code") or "").strip()
    if not ticket_id:
        return jsonify({"error": "Missing ticket_id"}), 400

    with remote_scan_lock:
        remote_scan_counter += 1
        event = {
            "id": remote_scan_counter,
            "ticket_id": ticket_id,
            "action": data.get("action", "checkout"),
            "timestamp": time.time(),
            "source": data.get("source", "phone")
        }
        remote_scan_events.append(event)
        if len(remote_scan_events) > 30:
            remote_scan_events.pop(0)

    return jsonify({
        "success": True,
        "message": f"Ticket {ticket_id} beamed to Check-Out counter",
        "event": event
    })


@app.get("/api/remote-scan/latest")
def get_latest_remote_scan():
    since = request.args.get("since", 0, type=float)
    with remote_scan_lock:
        new_events = [e for e in remote_scan_events if e["timestamp"] > since]
        latest = remote_scan_events[-1] if remote_scan_events else None
    return jsonify({
        "events": new_events,
        "latest": latest,
        "count": len(new_events)
    })


# ============================================================
# GET PARKING SPACES
# ============================================================

@app.get("/api/spaces")
def get_spaces():
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT space_number, status
                FROM parking_spaces
                ORDER BY space_number
            """)
            rows = cursor.fetchall()
            result = [row_to_dict(cursor, row) for row in rows]
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


# ============================================================
# GET MOTORCYCLES
# ============================================================

@app.get("/api/motorcycles")
def get_motorcycles():
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT id, COALESCE(moto_id, CAST(id AS VARCHAR)) AS moto_id, plate_number, created_at
                FROM motorcycles
                ORDER BY created_at DESC
            """)
            rows = cursor.fetchall()
            result = [row_to_dict(cursor, row) for row in rows]
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


# ============================================================
# GET PARKING RECORDS
# ============================================================

@app.get("/api/records")
def get_records():
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT
                    pr.id,
                    pr.record_id,
                    pr.space_number,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS moto_id,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS plate,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS plate_number,
                    pr.entry_time AS arrival_time,
                    pr.entry_time,
                    pr.exit_time,
                    pr.duration_minutes,
                    pr.verification,
                    pr.status,
                    pr.parking_fee AS fee,
                    pr.parking_fee,
                    pr.payment_status,
                    pr.driver_image,
                    pr.motorcycle_image,
                    pr.plate_image,
                    pr.exit_image,
                    COALESCE(s.full_name, 'System') AS processed_by,
                    pr.motorcycle_id,
                    pr.staff_id
                FROM parking_records pr
                LEFT JOIN motorcycles m ON pr.motorcycle_id = m.id
                LEFT JOIN staff s ON pr.staff_id = s.id
                ORDER BY pr.entry_time DESC
            """)
            rows = cursor.fetchall()
            result = [row_to_dict(cursor, row) for row in rows]
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.get("/api/records/<path:record_id>")
def get_single_record(record_id):
    conn = None
    try:
        conn = get_connection()
        clean_code = str(record_id).strip()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT
                    pr.id,
                    pr.record_id,
                    pr.space_number,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS moto_id,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS plate,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS plate_number,
                    pr.entry_time AS arrival_time,
                    pr.entry_time,
                    pr.exit_time,
                    pr.duration_minutes,
                    pr.verification,
                    pr.status,
                    pr.parking_fee AS fee,
                    pr.parking_fee,
                    pr.payment_status,
                    pr.driver_image,
                    pr.motorcycle_image,
                    pr.plate_image,
                    pr.exit_image,
                    COALESCE(s.full_name, 'System') AS processed_by,
                    pr.motorcycle_id,
                    pr.staff_id
                FROM parking_records pr
                LEFT JOIN motorcycles m ON pr.motorcycle_id = m.id
                LEFT JOIN staff s ON pr.staff_id = s.id
                WHERE pr.record_id = %s 
                   OR CAST(pr.id AS TEXT) = %s 
                   OR pr.moto_id = %s
                   OR m.moto_id = %s
                   OR LOWER(COALESCE(m.plate_number, '')) = LOWER(%s)
                   OR pr.space_number = %s
                ORDER BY pr.entry_time DESC
                LIMIT 1
            """, (clean_code, clean_code, clean_code, clean_code, clean_code, clean_code))
            row = cursor.fetchone()
            if not row:
                return jsonify({"error": f"Record {record_id} not found"}), 404
            return jsonify(row_to_dict(cursor, row))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


# ============================================================
# REPORTS
# ============================================================

@app.get("/api/weekend-report")
def weekend_report():
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT
                    COUNT(*) AS total_motorcycles,
                    COALESCE(SUM(COALESCE(parking_fee, 0)), 0) AS total_fee_riel
                FROM parking_records
                WHERE status = 'COMPLETED'
                  AND EXTRACT(DOW FROM exit_time) IN (0, 6)
                  AND exit_time >= CURRENT_DATE - INTERVAL '7 days'
            """)
            row = cursor.fetchone()
            return jsonify({
                "total_motorcycles": int(row[0] or 0),
                "total_fee_riel": int(row[1] or 0)
            })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.get("/api/daily-report")
def daily_report():
    """Return today's check-ins, completed check-outs, and revenue."""
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT
                    COUNT(CASE
                        WHEN entry_time >= CURRENT_DATE
                         AND entry_time < CURRENT_DATE + INTERVAL '1 day'
                        THEN 1
                    END) AS entered_today,

                    COUNT(CASE
                        WHEN status = 'COMPLETED'
                         AND exit_time >= CURRENT_DATE
                         AND exit_time < CURRENT_DATE + INTERVAL '1 day'
                        THEN 1
                    END) AS exited_today,

                    COALESCE(SUM(CASE
                        WHEN status = 'COMPLETED'
                         AND exit_time >= CURRENT_DATE
                         AND exit_time < CURRENT_DATE + INTERVAL '1 day'
                        THEN COALESCE(parking_fee, 0)
                        ELSE 0
                    END), 0) AS total_fee_riel
                FROM parking_records
            """)
            row = cursor.fetchone()
            return jsonify({
                "entered_today": int(row[0] or 0),
                "exited_today": int(row[1] or 0),
                "total_motorcycles": int(row[1] or 0),
                "fee_per_motorcycle": 300,
                "total_fee_riel": int(row[2] or 0)
            })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.get("/api/weekly-report")
def weekly_report():
    """Return completed parking and revenue for the last 7 calendar days."""
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT
                    COUNT(*) AS total_motorcycles,
                    COALESCE(SUM(COALESCE(parking_fee, 0)), 0) AS total_fee_riel
                FROM parking_records
                WHERE status = 'COMPLETED'
                  AND exit_time >= CURRENT_DATE - INTERVAL '6 days'
                  AND exit_time < CURRENT_DATE + INTERVAL '1 day'
            """)
            row = cursor.fetchone()
            return jsonify({
                "total_motorcycles": int(row[0] or 0),
                "fee_per_motorcycle": 300,
                "total_fee_riel": int(row[1] or 0)
            })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.get("/api/weekly-breakdown")
def weekly_breakdown():
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT
                    CAST(exit_time AS DATE) AS parking_date,
                    COUNT(*) AS total_motorcycles,
                    COALESCE(SUM(COALESCE(parking_fee, 0)), 0) AS total_fee_riel
                FROM parking_records
                WHERE status = 'COMPLETED'
                  AND exit_time >= CURRENT_DATE - INTERVAL '6 days'
                  AND exit_time < CURRENT_DATE + INTERVAL '1 day'
                GROUP BY CAST(exit_time AS DATE)
                ORDER BY parking_date
            """)
            rows = cursor.fetchall()
            result = []
            for row in rows:
                result.append({
                    "date": str(row[0]),
                    "total_motorcycles": int(row[1] or 0),
                    "total_fee_riel": int(row[2] or 0)
                })
            return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.get("/api/manager/financial-overview")
def manager_financial_overview():
    """Return all-time revenue, monthly totals, and staff performance breakdown for Manager."""
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            # 1. All-time completed totals
            cursor.execute("""
                SELECT 
                    COUNT(*) AS total_all_time,
                    COALESCE(SUM(COALESCE(parking_fee, 0)), 0) AS revenue_all_time,
                    COALESCE(AVG(duration_minutes), 0) AS avg_duration
                FROM parking_records
                WHERE status = 'COMPLETED';
            """)
            row_all = cursor.fetchone()

            # 2. This month completed totals
            cursor.execute("""
                SELECT 
                    COUNT(*) AS total_month,
                    COALESCE(SUM(COALESCE(parking_fee, 0)), 0) AS revenue_month
                FROM parking_records
                WHERE status = 'COMPLETED'
                  AND DATE_TRUNC('month', exit_time) = DATE_TRUNC('month', CURRENT_DATE);
            """)
            row_month = cursor.fetchone()

            # 3. Today completed totals
            cursor.execute("""
                SELECT 
                    COUNT(*) AS total_today,
                    COALESCE(SUM(COALESCE(parking_fee, 0)), 0) AS revenue_today
                FROM parking_records
                WHERE status = 'COMPLETED'
                  AND exit_time >= CURRENT_DATE;
            """)
            row_today = cursor.fetchone()

            # 4. Currently active parked count
            cursor.execute("SELECT COUNT(*) FROM parking_records WHERE status = 'PARKED';")
            active_parked = cursor.fetchone()[0]

            # 5. Total all-time records count
            cursor.execute("SELECT COUNT(*) FROM parking_records;")
            total_records = cursor.fetchone()[0]

            # 6. Staff cashier performance breakdown
            cursor.execute("""
                SELECT 
                    COALESCE(s.full_name, 'System / Kiosk') AS staff_name,
                    COALESCE(s.username, 'system') AS username,
                    COUNT(pr.id) AS total_processed,
                    COALESCE(SUM(CASE WHEN pr.status = 'COMPLETED' THEN COALESCE(pr.parking_fee, 0) ELSE 0 END), 0) AS total_collected
                FROM parking_records pr
                LEFT JOIN staff s ON pr.staff_id = s.id
                GROUP BY s.full_name, s.username
                ORDER BY total_collected DESC, total_processed DESC;
            """)
            staff_rows = cursor.fetchall()
            staff_breakdown = [
                {
                    "staff_name": r[0],
                    "username": r[1],
                    "total_processed": int(r[2]),
                    "total_collected": int(r[3])
                }
                for r in staff_rows
            ]

            return jsonify({
                "all_time_motorcycles": int(row_all[0] or 0),
                "all_time_revenue": int(row_all[1] or 0),
                "avg_duration_minutes": round(float(row_all[2] or 0)),
                "month_motorcycles": int(row_month[0] or 0),
                "month_revenue": int(row_month[1] or 0),
                "today_motorcycles": int(row_today[0] or 0),
                "today_revenue": int(row_today[1] or 0),
                "active_parked": int(active_parked),
                "total_records": int(total_records),
                "staff_breakdown": staff_breakdown
            })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.get("/api/staff/shift-summary")
def staff_shift_summary():
    """Return shift summary and cash drawer collection tally for cashier staff."""
    conn = None
    try:
        user_id = session.get("user_id")
        user_name = session.get("fullname", "Staff Cashier")
        conn = get_connection()
        with conn.cursor() as cursor:
            # Shift transactions completed today by current staff
            if user_id and session.get("role") in ["Parking Employee", "Staff"]:
                cursor.execute("""
                    SELECT 
                        COUNT(CASE WHEN entry_time >= CURRENT_DATE THEN 1 END) AS checkins_today,
                        COUNT(CASE WHEN status = 'COMPLETED' AND exit_time >= CURRENT_DATE THEN 1 END) AS checkouts_today,
                        COALESCE(SUM(CASE WHEN status = 'COMPLETED' AND exit_time >= CURRENT_DATE THEN COALESCE(parking_fee, 0) ELSE 0 END), 0) AS collected_today
                    FROM parking_records
                    WHERE staff_id = %s;
                """, (user_id,))
            else:
                cursor.execute("""
                    SELECT 
                        COUNT(CASE WHEN entry_time >= CURRENT_DATE THEN 1 END) AS checkins_today,
                        COUNT(CASE WHEN status = 'COMPLETED' AND exit_time >= CURRENT_DATE THEN 1 END) AS checkouts_today,
                        COALESCE(SUM(CASE WHEN status = 'COMPLETED' AND exit_time >= CURRENT_DATE THEN COALESCE(parking_fee, 0) ELSE 0 END), 0) AS collected_today
                    FROM parking_records;
                """)
            row = cursor.fetchone()

            cursor.execute("SELECT COUNT(*) FROM parking_records WHERE status = 'PARKED';")
            active_parked = cursor.fetchone()[0]

            return jsonify({
                "cashier_name": user_name,
                "checkins_today": int(row[0] or 0),
                "checkouts_today": int(row[1] or 0),
                "collected_today": int(row[2] or 0),
                "active_parked": int(active_parked),
                "standard_fee": 300,
                "date": datetime.now().strftime("%Y-%m-%d")
            })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


# ============================================================
# CHECK-IN
# ============================================================

@app.post("/api/check-in")
def check_in():
    data = request.get_json(silent=True) or {}
    raw_id = str(data.get("moto_id") or data.get("id") or data.get("plate") or "").strip()
    driver = str(data.get("driver", "Captured")).strip()
    motorcycle_desc = str(data.get("motorcycle", "Captured")).strip()

    driver_image_data = data.get("driver_image")
    motorcycle_image_data = data.get("motorcycle_image")
    plate_image_data = data.get("plate_image")

    # If ID was provided, validate it contains numbers only
    if raw_id and not raw_id.isdigit():
        return jsonify({"error": "Moto ID must contain only numbers (digits)."}), 400

    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            # Generate strong numeric ID if none provided
            if raw_id:
                moto_id = raw_id
            else:
                moto_id = generate_strong_numeric_id(cursor)

            # 1. Register or find motorcycle in motorcycles table
            cursor.execute("SELECT id FROM motorcycles WHERE moto_id = %s", (moto_id,))
            m_row = cursor.fetchone()
            if m_row:
                motorcycle_id = m_row[0]
            else:
                cursor.execute(
                    "INSERT INTO motorcycles (moto_id, plate_number) VALUES (%s, %s) RETURNING id;",
                    (moto_id, moto_id)
                )
                motorcycle_id = cursor.fetchone()[0]

            # Prevent duplicate active check-in for the same motorcycle
            cursor.execute("""
                SELECT id, space_number FROM parking_records
                WHERE motorcycle_id = %s AND status = 'PARKED';
            """, (motorcycle_id,))
            active_parked = cursor.fetchone()
            if active_parked:
                return jsonify({"error": f"Motorcycle ID {moto_id} is already checked in at space {active_parked[1]}."}), 409

            # 2. Determine staff_id
            staff_id = None
            if session.get("role") in ["Parking Employee", "Staff"] and session.get("user_id"):
                staff_id = session.get("user_id")
            else:
                cursor.execute("SELECT id FROM staff ORDER BY id LIMIT 1;")
                s_row = cursor.fetchone()
                if s_row:
                    staff_id = s_row[0]

            # 3. Find an available parking space
            cursor.execute("""
                SELECT id, space_number
                FROM parking_spaces
                WHERE status = 'available'
                ORDER BY space_number
                LIMIT 1
            """)
            space = cursor.fetchone()
            if not space:
                return jsonify({"error": "No available parking spaces."}), 409

            # 4. Generate parking record ID
            cursor.execute("""
                SELECT COALESCE(MAX(id), 0) + 1
                FROM parking_records
            """)
            next_id = cursor.fetchone()[0]
            record_id = f"PK{next_id:05d}"

            now = datetime.now().replace(microsecond=0)

            driver_image_path = save_capture_image(record_id, "driver", driver_image_data)
            motorcycle_image_path = save_capture_image(record_id, "motorcycle", motorcycle_image_data)
            plate_image_path = save_capture_image(record_id, "plate", plate_image_data)

            # 5. Insert parking record with strong numeric moto_id (no plate saved)
            cursor.execute("""
                INSERT INTO parking_records
                (
                    record_id,
                    moto_id,
                    motorcycle_id,
                    staff_id,
                    space_number,
                    entry_time,
                    arrival_time,
                    plate,
                    parking_fee,
                    payment_status,
                    status,
                    verification,
                    driver_image,
                    motorcycle_image,
                    plate_image
                )
                VALUES
                (
                    %s, %s, %s, %s, %s, %s, %s, NULL,
                    300,
                    'UNPAID',
                    'PARKED',
                    'NOT VERIFIED',
                    %s, %s, %s
                )
            """, (
                record_id,
                moto_id,
                motorcycle_id,
                staff_id,
                space[1],
                now,
                now,
                driver_image_path,
                motorcycle_image_path,
                plate_image_path
            ))

            # 6. Mark parking space as occupied
            cursor.execute("""
                UPDATE parking_spaces
                SET status = 'occupied'
                WHERE id = %s
            """, (space[0],))

            # 7. Fetch the created record with joined motorcycle and staff details
            cursor.execute("""
                SELECT
                    pr.id,
                    pr.record_id,
                    pr.space_number,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS moto_id,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS plate,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS plate_number,
                    pr.entry_time AS arrival_time,
                    pr.entry_time,
                    pr.exit_time,
                    pr.duration_minutes,
                    pr.verification,
                    pr.status,
                    pr.parking_fee AS fee,
                    pr.parking_fee,
                    pr.payment_status,
                    pr.driver_image,
                    pr.motorcycle_image,
                    pr.plate_image,
                    pr.exit_image,
                    COALESCE(s.full_name, 'System') AS processed_by,
                    pr.motorcycle_id,
                    pr.staff_id
                FROM parking_records pr
                LEFT JOIN motorcycles m ON pr.motorcycle_id = m.id
                LEFT JOIN staff s ON pr.staff_id = s.id
                WHERE pr.record_id = %s
            """, (record_id,))

            record = cursor.fetchone()
            conn.commit()
            result = row_to_dict(cursor, record)
        return jsonify(result), 201
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


# ============================================================
# CHECK-OUT
# ============================================================

@app.post("/api/check-out")
def check_out():
    data = request.get_json(silent=True) or {}
    search = str(data.get("record_id") or data.get("moto_id") or data.get("plate") or "").strip().upper()

    if not search:
        return jsonify({"error": "Record ID or Moto ID is required."}), 400

    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT
                    pr.id,
                    pr.record_id,
                    pr.space_number,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS moto_id,
                    pr.entry_time,
                    pr.motorcycle_id,
                    pr.staff_id
                FROM parking_records pr
                LEFT JOIN motorcycles m ON pr.motorcycle_id = m.id
                WHERE pr.status = 'PARKED'
                  AND (
                      pr.record_id = %s 
                   OR pr.moto_id = %s
                   OR m.moto_id = %s
                   OR m.plate_number = %s 
                   OR pr.space_number = %s 
                   OR CAST(pr.id AS VARCHAR) = %s
                  )
                LIMIT 1
            """, (search, search, search, search, search, search))
            record = cursor.fetchone()

            if not record:
                return jsonify({"error": "Active parking record not found."}), 404

            now = datetime.now().replace(microsecond=0)
            entry = record[4]
            duration_minutes = max(1, round((now - entry).total_seconds() / 60))

            checkout_staff_id = None
            if session.get("role") in ["Parking Employee", "Staff"] and session.get("user_id"):
                checkout_staff_id = session.get("user_id")

            exit_image_data = data.get("exit_image")
            exit_image_path = (
                save_capture_image(record[1], "exit", exit_image_data)
                if exit_image_data
                else None
            )

            cursor.execute("""
                UPDATE parking_records
                SET
                    exit_time = %s,
                    duration_minutes = %s,
                    verification = 'VERIFIED',
                    status = 'COMPLETED',
                    parking_fee = 300,
                    fee = 300,
                    payment_status = 'PAID',
                    staff_id = COALESCE(%s, staff_id),
                    exit_image = COALESCE(%s, exit_image)
                WHERE id = %s
            """, (now, duration_minutes, checkout_staff_id, exit_image_path, record[0]))

            cursor.execute("""
                UPDATE parking_spaces
                SET status = 'available'
                WHERE space_number = %s
            """, (record[2],))

            cursor.execute("""
                SELECT
                    pr.id,
                    pr.record_id,
                    pr.space_number,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS moto_id,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS plate,
                    COALESCE(pr.moto_id, m.moto_id, CAST(m.id AS VARCHAR)) AS plate_number,
                    pr.entry_time AS arrival_time,
                    pr.entry_time,
                    pr.exit_time,
                    pr.duration_minutes,
                    pr.verification,
                    pr.status,
                    pr.parking_fee AS fee,
                    pr.parking_fee,
                    pr.payment_status,
                    pr.driver_image,
                    pr.motorcycle_image,
                    pr.plate_image,
                    pr.exit_image,
                    COALESCE(s.full_name, 'System') AS processed_by,
                    pr.motorcycle_id,
                    pr.staff_id
                FROM parking_records pr
                LEFT JOIN motorcycles m ON pr.motorcycle_id = m.id
                LEFT JOIN staff s ON pr.staff_id = s.id
                WHERE pr.id = %s
            """, (record[0],))

            completed = cursor.fetchone()
            conn.commit()
            result = row_to_dict(cursor, completed)
        return jsonify(result)
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


# ============================================================
# RUN SERVER (DUAL WINDOW LAUNCH)
# ============================================================

def launch_dual_windows(port):
    """Automatically open 2 browser windows on startup: 1. Login/Management, 2. Customer Kiosk."""
    import webbrowser
    time.sleep(1.2)
    try:
        # Window 1: Login / Management Console
        webbrowser.open(f"http://127.0.0.1:{port}/")
        time.sleep(0.6)
        # Window 2: Customer Kiosk Screen
        webbrowser.open(f"http://127.0.0.1:{port}/kiosk")
    except Exception as e:
        print(f"Note: Could not auto-launch browser windows: {e}")


if __name__ == "__main__":
    try:
        print("Initializing Sereyromanea Building PostgreSQL database...")
        initialize_database()
        print("Database initialization completed successfully.")
    except Exception as e:
        print("DATABASE INITIALIZATION ERROR:")
        print(e)
        raise

    port = int(os.getenv("PORT", "5000"))
    lan_ip = get_local_lan_ip()
    print("Starting Sereyromanea Building Flask server...")
    print(f"Server (Window 1 - Login):  http://127.0.0.1:{port}/")
    print(f"Server (Window 2 - Kiosk):  http://127.0.0.1:{port}/kiosk")
    print(f"Phone Access (Local Wi-Fi): http://{lan_ip}:{port}/")

    # Launch dual windows (Window 1: Login, Window 2: Kiosk)
    # Only launch in the active worker process to avoid duplicates during debug reload
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or os.getenv("FLASK_DEBUG") == "0":
        threading.Thread(target=launch_dual_windows, args=(port,), daemon=True).start()

    ensure_stream_worker_running()

    app.run(
        host="0.0.0.0",
        port=port,
        debug=True
    )