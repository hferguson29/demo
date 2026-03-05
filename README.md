# MOTCO Notification Service (On-Premise)

## Overview

This is a legacy on-premise notification service used to coordinate shipment events across the Joint Deployment and Distribution Enterprise (JDDE). It runs as a monolithic Express.js application on a single server within the USTRANSCOM Distributed Enclave.

The service handles event-driven notifications between logistics systems involved in ammunition and cargo movement at Military Ocean Terminal Concord (MOTCO) and similar DOD port facilities.

## What This Service Does

When cargo moves through the Defense Transportation System, multiple systems need to be notified at each stage. This service acts as the integration layer — it receives shipment events from source systems and fans them out to downstream consumers.

### Notification Types

| Type | Trigger | Downstream Consumers |
|------|---------|---------------------|
| `MANIFEST_READY` | CMOS completes cargo manifest for a vessel | GATES, ICODES, SMS |
| `SHIPMENT_DEPARTED` | Vessel departs port with cargo | DTTS, GTN, SMS |
| `SHIPMENT_DELAYED` | Delay detected (weather, mechanical, port congestion) | SMS, planning systems |
| `RFID_SCAN_EVENT` | RFID interrogator reads tag at checkpoint | RF-ITV, GTN |
| `SUSTAINMENT_REQUEST` | Forward unit requests resupply | CMOS, planning systems |
| `DIVERSION_ALERT` | Shipment rerouted due to contested conditions | GATES, SMS, all subscribers |

### Current Architecture Problems

1. **Point-to-point delivery**: Notifications are sent via synchronous HTTP calls to each consumer. If a consumer is down, the notification is lost — no retry, no queue, no dead letter handling.
2. **Single server**: Runs on one instance in the Distributed Enclave. If the server goes down, all notification flow stops.
3. **No event persistence**: Events are stored in-memory only. Server restart = all pending notifications lost.
4. **No fan-out**: Each notification type has hardcoded recipient lists. Adding a new consumer requires code changes and redeployment.
5. **No DDIL support**: Cannot operate in disconnected or degraded network conditions. No edge deployment capability.
6. **Synchronous blocking**: Sending notifications to 3-4 consumers happens sequentially. A slow or unresponsive consumer blocks all subsequent deliveries.

## API Endpoints

```
POST   /api/events                  — Ingest a new shipment event
GET    /api/events/:id              — Get event status and delivery report
GET    /api/events                  — List recent events (with optional type filter)
POST   /api/events/:id/retry        — Manually retry failed deliveries
POST   /api/subscribe               — Register a downstream system as a subscriber
DELETE /api/subscribe/:subscriberId — Remove a subscriber
GET    /api/health                  — Health check
```

## Data Flow

```
Source System (CMOS, RFID reader, etc.)
        |
        v
  POST /api/events  { type, tcn, payload }
        |
        v
  Notification Service (this app)
        |
        |--- HTTP POST ---> GATES endpoint (synchronous, no retry)
        |--- HTTP POST ---> SMS endpoint (synchronous, no retry)
        |--- HTTP POST ---> GTN endpoint (synchronous, no retry)
        |
        v
  Event stored in-memory (lost on restart)
```

## Running Locally

```bash
npm install
npm start
# Server runs on port 3000
```

## Migration Target

This service should be migrated to AWS Lambda with:
- SNS topics for event fan-out (replacing synchronous HTTP calls)
- SQS queues for reliable delivery with retry and dead-letter handling
- DynamoDB for event persistence (replacing in-memory storage)
- API Gateway for the HTTP interface
- CloudFormation/CDK for infrastructure-as-code
- Comprehensive unit and integration tests
