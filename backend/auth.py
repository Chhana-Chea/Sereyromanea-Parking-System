import os
import psycopg2
from flask import Blueprint, request, jsonify, session
from werkzeug.security import generate_password_hash, check_password_hash

auth_bp = Blueprint('auth', __name__)


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


def verify_user_password(stored_password, provided_password):
    """Support both Werkzeug secure hashes and direct plain-text entry in pgAdmin."""
    if not stored_password:
        return False
    if stored_password == provided_password:
        return True
    try:
        return check_password_hash(stored_password, provided_password)
    except Exception:
        return False


def initialize_auth_database(connection):
    """Create managers and staff tables in PostgreSQL and seed defaults."""
    cursor = connection.cursor()

    # 1. Create managers table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS managers (
            id SERIAL PRIMARY KEY,
            full_name VARCHAR(100) NOT NULL,
            username VARCHAR(50) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            phone VARCHAR(30),
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # 2. Create staff table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS staff (
            id SERIAL PRIMARY KEY,
            full_name VARCHAR(100) NOT NULL,
            username VARCHAR(50) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            phone VARCHAR(30),
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    """)
    connection.commit()

    # 3. Drop legacy 'users' table so pgAdmin only contains managers and staff
    cursor.execute("DROP TABLE IF EXISTS users CASCADE;")
    connection.commit()

    # 4. Seed default manager (admin / admin123)
    cursor.execute("SELECT COUNT(*) FROM managers;")
    if cursor.fetchone()[0] == 0:
        hashed_admin = generate_password_hash("admin123")
        cursor.execute("""
            INSERT INTO managers (full_name, username, password, phone)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (username) DO NOTHING;
        """, ("Admin", "admin", hashed_admin, "012345678"))

    # 5. Seed default staff (cashier / cashier123)
    cursor.execute("SELECT COUNT(*) FROM staff;")
    if cursor.fetchone()[0] == 0:
        hashed_cashier = generate_password_hash("cashier123")
        cursor.execute("""
            INSERT INTO staff (full_name, username, password, phone)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (username) DO NOTHING;
        """, ("Cashier Staff", "cashier", hashed_cashier, "098765432"))

    # 6. Ensure admin is strictly in managers, and cashier is strictly in staff
    cursor.execute("DELETE FROM staff WHERE username = 'admin';")
    cursor.execute("DELETE FROM managers WHERE username = 'cashier';")

    connection.commit()


@auth_bp.post("/api/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            # First check managers table
            cursor.execute("""
                SELECT id, username, password, full_name, phone
                FROM managers
                WHERE username = %s
            """, (username,))
            manager_row = cursor.fetchone()

            if manager_row and verify_user_password(manager_row[2], password):
                session["user_id"] = manager_row[0]
                session["username"] = manager_row[1]
                session["fullname"] = manager_row[3]
                session["phone"] = manager_row[4] or ""
                session["role"] = "Manager"
                session["user_type"] = "manager"

                return jsonify({
                    "success": True,
                    "user": {
                        "id": manager_row[0],
                        "username": manager_row[1],
                        "fullname": manager_row[3],
                        "role": "Manager",
                        "phone": manager_row[4] or "",
                        "user_type": "manager"
                    }
                })

            # Next check staff table
            cursor.execute("""
                SELECT id, username, password, full_name, phone
                FROM staff
                WHERE username = %s
            """, (username,))
            staff_row = cursor.fetchone()

            if staff_row and verify_user_password(staff_row[2], password):
                session["user_id"] = staff_row[0]
                session["username"] = staff_row[1]
                session["fullname"] = staff_row[3]
                session["phone"] = staff_row[4] or ""
                session["role"] = "Parking Employee"
                session["user_type"] = "staff"

                return jsonify({
                    "success": True,
                    "user": {
                        "id": staff_row[0],
                        "username": staff_row[1],
                        "fullname": staff_row[3],
                        "role": "Parking Employee",
                        "phone": staff_row[4] or "",
                        "user_type": "staff"
                    }
                })

            return jsonify({"error": "Invalid username or password"}), 401

    except Exception as e:
        return jsonify({"error": f"Database error: {str(e)}"}), 500
    finally:
        if conn:
            conn.close()


@auth_bp.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify({"success": True, "message": "Logged out successfully"})


@auth_bp.get("/api/auth/status")
def status():
    if "username" in session:
        return jsonify({
            "logged_in": True,
            "user": {
                "id": session.get("user_id"),
                "username": session.get("username"),
                "fullname": session.get("fullname"),
                "role": session.get("role"),
                "phone": session.get("phone", ""),
                "user_type": session.get("user_type", "staff")
            }
        })
    return jsonify({"logged_in": False, "user": None}), 200


# ============================================================
# USER MANAGEMENT (CRUD)
# ============================================================

def require_manager():
    return "role" in session and session["role"] == "Manager"


@auth_bp.get("/api/users")
def get_users():
    if not require_manager():
        return jsonify({"error": "Unauthorized. Manager access required."}), 403
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT id, username, full_name, 'Manager' AS role, phone, 'manager' AS user_type
                FROM managers
                UNION ALL
                SELECT id, username, full_name, 'Parking Employee' AS role, phone, 'staff' AS user_type
                FROM staff
                ORDER BY full_name
            """)
            rows = cursor.fetchall()
            users = []
            for r in rows:
                users.append({
                    "id": r[0],
                    "username": r[1],
                    "fullname": r[2],
                    "role": r[3],
                    "phone": r[4] or "",
                    "user_type": r[5]
                })
            return jsonify(users)
    except Exception as e:
        return jsonify({"error": f"Database error: {str(e)}"}), 500
    finally:
        if conn:
            conn.close()


@auth_bp.post("/api/users")
def create_user():
    if not require_manager():
        return jsonify({"error": "Unauthorized. Manager access required."}), 403
    
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()
    fullname = str(data.get("fullname", "")).strip()
    role = str(data.get("role", "")).strip()
    phone = str(data.get("phone", "")).strip()

    if not username or not password or not fullname or not role:
        return jsonify({"error": "All fields are required"}), 400

    conn = None
    try:
        hashed_password = generate_password_hash(password)
        conn = get_connection()
        with conn.cursor() as cursor:
            # Check unique username across both tables
            cursor.execute("SELECT COUNT(*) FROM managers WHERE username = %s", (username,))
            count_m = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM staff WHERE username = %s", (username,))
            count_s = cursor.fetchone()[0]

            if count_m > 0 or count_s > 0:
                return jsonify({"error": f"Username '{username}' is already taken"}), 409

            if role == "Manager":
                cursor.execute("""
                    INSERT INTO managers (username, password, full_name, phone)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id;
                """, (username, hashed_password, fullname, phone))
                new_id = cursor.fetchone()[0]
            else:
                cursor.execute("""
                    INSERT INTO staff (username, password, full_name, phone)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id;
                """, (username, hashed_password, fullname, phone))
                new_id = cursor.fetchone()[0]

            conn.commit()
            return jsonify({"success": True, "message": "User created successfully", "id": new_id}), 201
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": f"Database error: {str(e)}"}), 500
    finally:
        if conn:
            conn.close()


@auth_bp.put("/api/users/<int:user_id>")
def update_user(user_id):
    if not require_manager():
        return jsonify({"error": "Unauthorized. Manager access required."}), 403

    data = request.get_json(silent=True) or {}
    fullname = str(data.get("fullname", "")).strip()
    role = str(data.get("role", "")).strip()
    password = str(data.get("password", "")).strip()
    phone = str(data.get("phone", "")).strip()

    if not fullname or not role:
        return jsonify({"error": "Full name and role are required"}), 400

    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            # Check if user is in managers
            cursor.execute("SELECT id, username, password, phone FROM managers WHERE id = %s", (user_id,))
            mgr = cursor.fetchone()

            # Check if user is in staff
            cursor.execute("SELECT id, username, password, phone FROM staff WHERE id = %s", (user_id,))
            stf = cursor.fetchone()

            if not mgr and not stf:
                return jsonify({"error": "User not found"}), 404

            is_manager_table = mgr is not None
            current_pwd = mgr[2] if mgr else stf[2]
            current_username = mgr[1] if mgr else stf[1]

            new_pwd = generate_password_hash(password) if password else current_pwd

            target_is_manager = (role == "Manager")

            if is_manager_table == target_is_manager:
                table = "managers" if target_is_manager else "staff"
                cursor.execute(f"""
                    UPDATE {table}
                    SET full_name = %s, password = %s, phone = %s
                    WHERE id = %s
                """, (fullname, new_pwd, phone, user_id))
            else:
                # Role changed: Move from one table to the other
                if is_manager_table:
                    cursor.execute("DELETE FROM managers WHERE id = %s", (user_id,))
                    cursor.execute("""
                        INSERT INTO staff (full_name, username, password, phone)
                        VALUES (%s, %s, %s, %s)
                    """, (fullname, current_username, new_pwd, phone))
                else:
                    cursor.execute("DELETE FROM staff WHERE id = %s", (user_id,))
                    cursor.execute("""
                        INSERT INTO managers (full_name, username, password, phone)
                        VALUES (%s, %s, %s, %s)
                    """, (fullname, current_username, new_pwd, phone))

            if session.get("username") == current_username:
                session["fullname"] = fullname
                session["role"] = role
                if phone:
                    session["phone"] = phone

            conn.commit()
            return jsonify({"success": True, "message": "User updated successfully"})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": f"Database error: {str(e)}"}), 500
    finally:
        if conn:
            conn.close()


@auth_bp.delete("/api/users/<int:user_id>")
def delete_user(user_id):
    if not require_manager():
        return jsonify({"error": "Unauthorized. Manager access required."}), 403

    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            # Check manager table
            cursor.execute("SELECT username FROM managers WHERE id = %s", (user_id,))
            row = cursor.fetchone()
            table = "managers"

            if not row:
                cursor.execute("SELECT username FROM staff WHERE id = %s", (user_id,))
                row = cursor.fetchone()
                table = "staff"

            if not row:
                return jsonify({"error": "User not found"}), 404

            username = row[0]
            if username == "admin":
                return jsonify({"error": "Cannot delete primary admin account"}), 400

            if session.get("username") == username:
                return jsonify({"error": "You cannot delete your own logged-in account"}), 400

            cursor.execute(f"DELETE FROM {table} WHERE id = %s", (user_id,))
            conn.commit()
            return jsonify({"success": True, "message": f"User '{username}' deleted successfully"})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": f"Database error: {str(e)}"}), 500
    finally:
        if conn:
            conn.close()
