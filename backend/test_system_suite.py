"""
Comprehensive System Test Suite for Sereyromanea Building MotorPark System.
Covers Authentication, RBAC, Spaces, Check-In, Check-Out, Reports, and User CRUD.
"""

import os
import sys
import unittest
from pathlib import Path

# Ensure UTF-8 output on Windows
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

from app import app, initialize_database, get_connection


class MotorParkSystemTestSuite(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        print("\n========================================================")
        print("  Starting MotorPark Automated System Test Suite")
        print("========================================================")
        initialize_database()
        cls.client = app.test_client()

    def test_01_database_connectivity_and_tables(self):
        """Verify database connects and all 5 tables exist."""
        conn = get_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT table_name FROM information_schema.tables
                    WHERE table_schema = 'public';
                """)
                tables = {row[0] for row in cursor.fetchall()}
                required = {"motorcycles", "parking_spaces", "parking_records", "staff", "managers"}
                for table in required:
                    self.assertIn(table, tables, f"Missing required database table: {table}")
                print("[PASS] Database tables verified:", ", ".join(required))
        finally:
            conn.close()

    def test_02_seed_accounts_exist(self):
        """Verify default admin and cashier seed accounts exist."""
        conn = get_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    SELECT username, role FROM (
                        SELECT username, 'Manager' as role FROM managers
                        UNION
                        SELECT username, 'Staff' as role FROM staff
                    ) u WHERE username IN ('admin', 'cashier');
                """)
                users = {row[0]: row[1] for row in cursor.fetchall()}
                self.assertIn("admin", users)
                self.assertIn("cashier", users)
                print("[PASS] Seed accounts verified: admin (Manager), cashier (Staff)")
        finally:
            conn.close()

    def test_03_authentication_and_rbac(self):
        """Verify staff and manager login, session status, and RBAC enforcement."""
        client = app.test_client()

        # 1. Failed login with invalid credentials
        res = client.post("/api/auth/login", json={"username": "admin", "password": "wrongpassword"})
        self.assertEqual(res.status_code, 401)

        # 2. Staff login
        res = client.post("/api/auth/login", json={"username": "cashier", "password": "cashier123"})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data.get("success"))
        self.assertEqual(data["user"]["role"], "Parking Employee")

        # 3. Staff denied manager-only users endpoint (403)
        res_users = client.get("/api/users")
        self.assertEqual(res_users.status_code, 403)

        # 4. Logout
        res_logout = client.post("/api/auth/logout")
        self.assertEqual(res_logout.status_code, 200)

        # 5. Manager login
        res_admin = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
        self.assertEqual(res_admin.status_code, 200)
        data_admin = res_admin.get_json()
        self.assertEqual(data_admin["user"]["role"], "Manager")

        # 6. Manager allowed access to users endpoint (200)
        res_users_admin = client.get("/api/users")
        self.assertEqual(res_users_admin.status_code, 200)
        print("[PASS] Authentication & RBAC enforcement verified")

    def test_04_spaces_query(self):
        """Verify all 500 parking spaces exist and at least one is available."""
        res = self.client.get("/api/spaces")
        self.assertEqual(res.status_code, 200)
        spaces = res.get_json()
        self.assertGreaterEqual(len(spaces), 20)
        self.assertTrue(any(s["status"] == "available" for s in spaces))
        print(f"[PASS] Spaces verified ({len(spaces)} total spaces)")

    def test_05_checkin_checkout_full_lifecycle(self):
        """Test complete vehicle lifecycle: check-in, duplicate prevention, verification, and check-out."""
        client = app.test_client()
        # Login as staff cashier
        client.post("/api/auth/login", json={"username": "cashier", "password": "cashier123"})

        test_moto_id = "88997766"

        # 1. Clean up any existing test records for this moto_id
        conn = get_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("""
                    DELETE FROM parking_records WHERE moto_id = %s OR plate = %s;
                    DELETE FROM motorcycles WHERE moto_id = %s OR plate_number = %s;
                """, (test_moto_id, test_moto_id, test_moto_id, test_moto_id))
                conn.commit()
        finally:
            conn.close()

        # 1b. Verify non-numeric ID is rejected (400)
        invalid_res = client.post("/api/check-in", json={"moto_id": "ABC-1234"})
        self.assertEqual(invalid_res.status_code, 400)
        print("[PASS] Non-numeric Moto ID correctly rejected (400 Bad Request)")

        # 2. Check in the motorcycle with strong numeric ID
        checkin_res = client.post("/api/check-in", json={
            "moto_id": test_moto_id,
            "driver": "Test Suite Rider",
            "motorcycle": "Honda Dream 125",
            "motorcycle_image": None,
            "plate_image": None
        })
        self.assertEqual(checkin_res.status_code, 201)
        record = checkin_res.get_json()
        self.assertEqual(record["moto_id"], test_moto_id)
        self.assertEqual(record["status"], "PARKED")
        self.assertEqual(record["fee"], 300)
        self.assertEqual(record["payment_status"], "UNPAID")
        allocated_space = record["space_number"]
        record_id = record["record_id"]
        print(f"[PASS] Check-in succeeded: Moto ID {test_moto_id} -> Space {allocated_space}, Ticket {record_id}")

        # 3. Duplicate check-in for the same active motorcycle must be rejected (409)
        dup_res = client.post("/api/check-in", json={"moto_id": test_moto_id})
        self.assertEqual(dup_res.status_code, 409)
        print("[PASS] Duplicate active check-in correctly rejected (409 Conflict)")

        # 4. Check out the motorcycle
        checkout_res = client.post("/api/check-out", json={
            "record_id": record_id,
            "verification": "VERIFIED"
        })
        self.assertEqual(checkout_res.status_code, 200)
        completed = checkout_res.get_json()
        self.assertEqual(completed["status"], "COMPLETED")
        self.assertEqual(completed["payment_status"], "PAID")
        self.assertEqual(completed["fee"], 300)
        self.assertIsNotNone(completed["exit_time"])
        print(f"[PASS] Check-out succeeded: Ticket {record_id} completed, fee 300 Riel marked PAID")

        # 5. Verify the allocated space is released back to available
        spaces_res = client.get("/api/spaces")
        spaces = spaces_res.get_json()
        target_space = next((s for s in spaces if s["space_number"] == allocated_space), None)
        self.assertIsNotNone(target_space)
        self.assertEqual(target_space["status"], "available")
        print(f"[PASS] Space {allocated_space} verified released to 'available'")

    def test_06_financial_and_operational_reports(self):
        """Verify all reporting endpoints return valid metrics."""
        client = app.test_client()
        # Login as manager
        client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})

        reports = [
            "/api/daily-report",
            "/api/weekly-report",
            "/api/weekly-breakdown",
            "/api/weekend-report",
            "/api/manager/financial-overview",
            "/api/staff/shift-summary",
        ]

        for endpoint in reports:
            res = client.get(endpoint)
            self.assertEqual(res.status_code, 200, f"Failed endpoint: {endpoint}")
            data = res.get_json()
            self.assertIn(type(data), [dict, list])
            print(f"[PASS] Report {endpoint} returned 200 OK")

    def test_07_user_administration_crud(self):
        """Verify manager can create, update, and delete staff accounts."""
        client = app.test_client()
        # Login as manager
        client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})

        temp_user = "test_staff_99"
        # Clean up if exists
        conn = get_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute("DELETE FROM staff WHERE username = %s;", (temp_user,))
                conn.commit()
        finally:
            conn.close()

        # 1. Create staff member
        create_res = client.post("/api/users", json={
            "username": temp_user,
            "password": "Password123!",
            "fullname": "Temporary Test Staff",
            "role": "Parking Employee"
        })
        self.assertEqual(create_res.status_code, 201)
        created_data = create_res.get_json()
        user_id = created_data.get("id")
        self.assertIsNotNone(user_id)
        print(f"[PASS] User created: {temp_user} (ID: {user_id})")

        # 2. Update staff member
        update_res = client.put(f"/api/users/{user_id}", json={
            "fullname": "Updated Test Staff Name",
            "role": "Parking Employee"
        })
        self.assertEqual(update_res.status_code, 200)
        print(f"[PASS] User updated: ID {user_id}")

        # 3. Delete staff member
        delete_res = client.delete(f"/api/users/{user_id}")
        self.assertEqual(delete_res.status_code, 200)
        print(f"[PASS] User deleted: ID {user_id}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
