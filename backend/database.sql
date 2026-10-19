-- ============================================================
-- MotorPark PostgreSQL Database Schema (pgAdmin)
-- ============================================================
-- Connect to database 'motorpark' in pgAdmin before running this script.

-- Drop legacy users table if it exists
DROP TABLE IF EXISTS users CASCADE;

-- 1. Motorcycles Table
CREATE TABLE IF NOT EXISTS motorcycles (
    id SERIAL PRIMARY KEY,
    moto_id VARCHAR(50) NOT NULL UNIQUE,
    plate_number VARCHAR(50),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Staff Table
CREATE TABLE IF NOT EXISTS staff (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    username VARCHAR(50) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    phone VARCHAR(30),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Managers Table
CREATE TABLE IF NOT EXISTS managers (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    username VARCHAR(50) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    phone VARCHAR(30),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Parking Spaces Table
CREATE TABLE IF NOT EXISTS parking_spaces (
    id SERIAL PRIMARY KEY,
    space_number VARCHAR(10) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'available'
);

-- 5. Parking Records Table
CREATE TABLE IF NOT EXISTS parking_records (
    id SERIAL PRIMARY KEY,
    record_id VARCHAR(30) UNIQUE,
    moto_id VARCHAR(50),
    motorcycle_id INT NOT NULL REFERENCES motorcycles(id) ON DELETE CASCADE,
    staff_id INT REFERENCES staff(id) ON DELETE SET NULL,
    manager_id INT REFERENCES managers(id) ON DELETE SET NULL,
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

-- ------------------------------------------------------------
-- Indexes for Performance
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_records_motorcycle_id ON parking_records(motorcycle_id);
CREATE INDEX IF NOT EXISTS idx_records_staff_id ON parking_records(staff_id);
CREATE INDEX IF NOT EXISTS idx_records_status ON parking_records(status);
CREATE INDEX IF NOT EXISTS idx_records_entry_time ON parking_records(entry_time);
CREATE INDEX IF NOT EXISTS idx_spaces_status ON parking_spaces(status);

-- ------------------------------------------------------------
-- Seed Initial Parking Spaces (001 to 500)
-- ------------------------------------------------------------
INSERT INTO parking_spaces (space_number, status)
SELECT 
    lpad(s::text, 3, '0'),
    'available'
FROM generate_series(1, 500) AS s
ON CONFLICT (space_number) DO NOTHING;

-- ------------------------------------------------------------
-- Seed Default Manager (admin / admin123)
-- ------------------------------------------------------------
INSERT INTO managers (full_name, username, password, phone)
VALUES ('Admin', 'admin', 'scrypt:32768:8:1$K5Kmsr5hWJ784P2v$b1675ba7ce446a80fa13813ff2c05008be515433604b9015c7e3f898fe7e4e138a34293fbfbb49141097beee756b107e3ea8ea8bb9886a8b75fc5c56d11f6c43', '012345678')
ON CONFLICT (username) DO NOTHING;

-- ------------------------------------------------------------
-- Seed Default Staff (cashier / cashier123)
-- ------------------------------------------------------------
INSERT INTO staff (full_name, username, password, phone)
VALUES ('Cashier Staff', 'cashier', 'scrypt:32768:8:1$17T66E3w2b42L5gV$684a0d9dc95ec87635ae0410ff1a43a0888eb7e39a3f2955f2cfc3b772bb2b4759bfd669528dbe4bcbe20042eb62a4d33457ddf5e1823eb52f4007d4b29bb8fe', '098765432')
ON CONFLICT (username) DO NOTHING;