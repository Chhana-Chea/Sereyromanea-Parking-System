# MotorPark

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python 3.10+" />
  <img src="https://img.shields.io/badge/Flask-3.0-000000?style=for-the-badge&logo=flask&logoColor=white" alt="Flask" />
  <img src="https://img.shields.io/badge/PostgreSQL-16%2B-336791?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL 16+" />
  <img src="https://img.shields.io/badge/ESP32-CAM-IoT-1C1E24?style=for-the-badge" alt="ESP32-CAM IoT" />
</p>

<p align="center">
  <strong>Intelligent Motorcycle Parking Management System</strong>
</p>

MotorPark is a full-stack, IoT-enabled motorcycle parking solution designed for modern parking facilities. It combines a web dashboard, automated vehicle check-in/check-out flow, live camera monitoring, image-based verification, and role-based access control for staff and managers.

## Overview

MotorPark helps parking operators manage vehicle entry/exit, space allocation, financial reporting, and audit operations from a single platform. The system supports:

- real-time parking slot tracking
- QR/ticket-based entry workflow
- ESP32-CAM snapshot and live camera integration
- full parking transaction history
- role-based access for staff and managers
- automated daily/weekly revenue reporting

## Why this project

Traditional motorcycle parking management is often manual and error-prone. This project digitalizes operations by:

- removing paper-based ticket tracking
- reducing idle space waste through automatic slot assignment
- improving security via photo verification
- giving managers useful financial analytics and reporting
- providing a kiosk-based customer flow for fast check-ins

---

## Key Features

### Customer & kiosk experience
- self-service entry flow for riders
- automatic ticket generation
- quick reset after check-in
- kiosk-friendly interface for fast use

### Staff operations
- check-in and check-out processing
- active parking list and slot status view
- image verification at exit
- fee calculation and payment processing
- transaction search and filtering

### Manager controls
- user account management
- staff and manager CRUD operations
- camera IP configuration
- revenue and financial summaries
- daily, weekly, and weekend report views

### IoT & automation
- ESP32-CAM live video and JPEG capture
- camera feed proxy through Flask backend
- buffered frame handling for fast snapshot access
- image storage mapped to parking records

---

## System Architecture

```text
+---------------------+      HTTP/JSON       +----------------------+
|                     | -------------------> |                      |
| Management Console  |                      | Flask Backend        |
| - Dashboard         |                      | - Auth & Sessions    |
| - Check-in/out     |                      | - Parking Logic      |
| - Reports          |                      | - Camera Proxy       |
| - Admin tools      |                      | - Analytics          |
+---------------------+                      +---------+------------+
                                                    |
                                                    v
                                      +---------------------------+
                                      | PostgreSQL Database       |
                                      | - motorcycles            |
                                      | - parking_spaces         |
                                      | - parking_records        |
                                      | - staff                  |
                                      | - managers               |
                                      +---------------------------+
                                                    ^
                                                    |
                                                    |
                                      +---------------------------+
                                      | ESP32-CAM Hardware       |
                                      | - MJPEG stream           |
                                      | - JPEG capture           |
                                      +---------------------------+
```

---

## Functional Flow

### 1. Check-in workflow
1. Rider arrives at the parking facility.
2. Staff or kiosk initiates a check-in request.
3. System captures a live image from the camera feed.
4. The system finds the next available parking slot.
5. Motorcycle record is created or matched.
6. A new parking record is created with `PARKED` status.
7. Images are stored and linked to the ticket.
8. Ticket is issued and the space is marked as occupied.

### 2. Check-out workflow
1. Rider presents ticket or plate information at exit.
2. Staff searches for the active parking record.
3. System calculates duration and fee.
4. Driver and vehicle photos are displayed for verification.
5. Staff confirms payment and release.
6. Record is marked `COMPLETED` and space becomes available.

### 3. Role-based access
| Role | Access |
| --- | --- |
| Public/Kiosk | self-service check-in |
| Staff | check-in/out, live camera, shift summary |
| Manager | all staff features + reports + user management |

---

## Tech Stack

### Frontend
- HTML5
- CSS3
- JavaScript ES6+
- Fetch API
- Responsive dashboard UI

### Backend
- Python 3.10+
- Flask
- PostgreSQL client (`psycopg2`)
- Session-based authentication
- Werkzeug password hashing

### Database
- PostgreSQL 14+
- relational schema with foreign keys
- normalized tables for vehicles, staff, managers, spaces, and records

### IoT layer
- ESP32-CAM
- MJPEG streaming
- JPEG snapshot capture
- image storage and retrieval via backend

---

## Project Structure

```text
MotorPark/
├── backend/
│   ├── app.py
│   ├── database.sql
│   ├── requirements.txt
│   ├── .env
│   ├── camera_config.json
│   └── uploads/
│       └── parking/
├── static/
│   ├── css/
│   ├── js/
│   └── images/
├── templates/
│   ├── index.html
│   ├── kiosk.html
│   └── ...
├── run_app.bat
├── README.md
└── .gitignore
```

---

## Database Model

The system uses a normalized relational schema with the following core entities:

- `motorcycles` — vehicle registry
- `parking_spaces` — slot state and allocation
- `staff` — cashier/attendant accounts
- `managers` — admin accounts
- `parking_records` — check-in/check-out transactions

### Core relationships
- one motorcycle can have many parking records
- one parking space can be assigned to many records over time
- each record references a vehicle, space, and staff member
- managers oversee operational records and analytics

---

## API Overview

### Authentication
| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Login with username and password |
| `POST` | `/api/auth/logout` | Clear session |
| `GET` | `/api/auth/status` | Check current user session |

### Parking operations
| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Service health check |
| `GET` | `/api/spaces` | Get available and occupied slots |
| `GET` | `/api/records` | View parking records |
| `POST` | `/api/check-in` | Create entry record |
| `POST` | `/api/check-out` | Complete parking session |

### Camera / IoT
| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/camera/stream` | Proxy MJPEG stream |
| `GET` | `/api/camera/snapshot` | Capture image snapshot |
| `GET` | `/api/camera/status` | Check connection status |
| `GET` | `/api/camera-config` | Read configured camera IP |
| `POST` | `/api/camera-config` | Update camera IP |

### Reports
| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/manager/financial-overview` | Gross revenue and breakdown |
| `GET` | `/api/staff/shift-summary` | Shift and cash summary |
| `GET` | `/api/daily-report` | Daily operation report |
| `GET` | `/api/weekly-report` | Weekly summary |
| `GET` | `/api/weekend-report` | Weekend performance report |

---

## Installation & Setup

### Prerequisites
- Python 3.10+
- PostgreSQL 14+
- Browser: Chrome, Edge, or Firefox
- Optional: ESP32-CAM device

### 1. Create the database
```sql
CREATE DATABASE motorpark;
```

Then run the schema file:

```bash
psql -U postgres -d motorpark -f backend/database.sql
```

### 2. Configure environment variables
Create a `.env` file inside `backend/` with:

```env
PGHOST=127.0.0.1
PGPORT=5433
PGDATABASE=motorpark
PGUSER=postgres
PGPASSWORD=123456789
PORT=5000
SECRET_KEY=motorpark_secret_key_prod_9876
ESP32_CAM_IP=172.20.10.12
```

### 3. Install dependencies
```powershell
pip install -r backend\requirements.txt
```

### 4. Run the project
```powershell
python backend\app.py
```

or from the root:

```powershell
.\run_app.bat
```

On startup, the application automatically verifies database tables, seeds required records, and opens the management dashboard and kiosk interface.

---

## Default Login Accounts

The system seeds default users during database setup:

| Role | Username | Password |
| --- | --- | --- |
| Manager | `admin` | `admin123` |
| Staff | `cashier` | `cashier123` |

> Change these credentials in a production environment before deployment.

---

## Security Notes

- password hashing is handled via Werkzeug Scrypt
- session-based access control is enforced for authenticated features
- manager-only routes should remain restricted to admin users
- camera IP configuration should be protected from unauthorized access

---

## Screenshots & Demo

Add screenshots here for:
- dashboard overview
- parking slot management
- customer kiosk
- exit verification modal
- reports screen

---

## Roadmap

- add QR-code ticket scanning
- include multi-device camera support
- expand analytics with charts and export options
- add notifications and audit logs
- improve kiosk UX and device responsiveness

---

## License

This project is intended for educational, prototype, and local deployment use. Update the license if you plan to distribute or commercialize it.

---

## Contact

If you want to extend this project, improve the UI, or add production-grade features, contact the repository maintainer or open an issue in the project.

"MotorPark helps organize parking, improve security, and simplify operations with smart infrastructure and data-driven workflows."

---

## Summary

MotorPark is a practical smart parking management system for motorcycle facilities, combining automation, user roles, and IoT monitoring to improve efficiency, security, and operational visibility.
