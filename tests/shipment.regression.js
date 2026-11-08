"use strict";

const { PostgreSqlContainer } = require("@testcontainers/postgresql");
const { Client } = require("pg");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { Customer, Parcel, ShipmentRequest, ShipmentStatus: S } = require("../src/models");
const { CustomerRepository, ParcelRepository, ShipmentRepository } = require("../src/repositories");
const { ShippingService, ShipmentRejectedError } = require("../src/service");

jest.setTimeout(120000);

let container;
let client;
let customers;
let parcels;
let shipments;
let service;

beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17.6-alpine").start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query(readFileSync(join(__dirname, "../migrations/V1__create_tables.sql"), "utf8"));
    customers = new CustomerRepository(client);
    parcels = new ParcelRepository(client);
    shipments = new ShipmentRepository(client);
    service = new ShippingService(customers, parcels, shipments, { isAllowed: async () => true });
});

afterAll(async () => {
    try {
        if (client) await client.end();
    } finally {
        if (container) await container.stop();
    }
});

const makeCustomer = () => customers.create(new Customer(0, `C-${randomUUID()}`, false));
const makeParcel = (weight = 1000, value = 0) =>
    parcels.create(new Parcel(0, `P-${randomUUID()}`, weight, value, 10, 10, 10));
const makeRequest = (person, parcel) =>
    new ShipmentRequest(`S-${randomUUID()}`, person.id, parcel.id, 100);

async function waitForShipment(customerId, predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = await shipments.findShipments(customerId, S.REGISTERED);
        const match = found.find(predicate);
        if (match) return match;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Умова не виконалась за ${timeoutMs} мс`);
}

const scenarios = [
    {
        name: "[SMOKE] Відправлення зберігається у БД",
        run: async () => {
            const saved = await service.createShipment(makeRequest(await makeCustomer(), await makeParcel()));
            expect(saved.status).toBe(S.REGISTERED);
            expect(await shipments.findById(saved.id)).toEqual(saved);
        }
    },
    {
        name: "[SMOKE] Передача відправлення в доставку",
        run: async () => {
            const person = await makeCustomer();
            const saved = await service.createShipment(makeRequest(person, await makeParcel()));
            const dispatched = await service.dispatch(saved.id);
            expect(dispatched.status).toBe(S.DISPATCHED);
            expect(await shipments.findById(saved.id)).toEqual(dispatched);
        }
    },
    {
        name: "[SMOKE] Картка посилки зберігає вагу",
        run: async () => {
            const saved = await makeParcel(1000, 0);
            expect((await parcels.findById(saved.id)).weightGrams).toBe(1000);
        }
    },
    {
        name: "[SMOKE] Картка посилки зберігає оголошену вартість",
        run: async () => {
            const saved = await makeParcel(2000, 10000);
            expect((await parcels.findById(saved.id)).declaredValue).toBe(10000);
        }
    },
    {
        name: "Відправлення після зовнішнього дозволу",
        run: async () => {
            const person = await makeCustomer();
            const parcel = await makeParcel();
            const data = makeRequest(person, parcel);
            const delayed = new ShippingService(customers, parcels, shipments, {
                isAllowed: async () => {
                    await new Promise(resolve => setTimeout(resolve, 80));
                    return true;
                }
            });
            const operation = delayed.createShipment(data);
            const saved = await waitForShipment(person.id, item => item.reference === data.reference);
            expect(saved.total).toBe(7000);
            await expect(operation).resolves.toMatchObject({ id: saved.id, reference: data.reference });
        }
    },
    {
        name: "Вибірка містить два відправлення клієнта у стабільному порядку",
        run: async () => {
            const person = await makeCustomer();
            const first = await service.createShipment(makeRequest(person, await makeParcel()));
            const second = await service.createShipment(makeRequest(person, await makeParcel()));
            const result = await client.query(
                "SELECT id, reference FROM shipments WHERE customer_id=$1 AND status=$2 ORDER BY id ASC",
                [person.id, S.REGISTERED]
            );
            expect(result.rows.map(item => Number(item.id))).toEqual([first.id, second.id]);
        }
    },
    {
        name: "[SMOKE] Завершення доставки зберігає стан",
        run: async () => {
            const saved = await service.createShipment(makeRequest(await makeCustomer(), await makeParcel()));
            await service.dispatch(saved.id);
            const delivered = await service.deliver(saved.id);
            expect(delivered.status).toBe(S.DELIVERED);
            expect(await shipments.findById(saved.id)).toEqual(delivered);
        }
    },
    {
        name: "Завершення до відправлення відхиляється",
        run: async () => {
            const saved = await service.createShipment(makeRequest(await makeCustomer(), await makeParcel()));
            await expect(service.deliver(saved.id)).rejects.toBeInstanceOf(ShipmentRejectedError);
            expect(await shipments.findById(saved.id)).toEqual(saved);
        }
    },
    {
        name: "Зовнішня відмова не створює відправлення",
        run: async () => {
            const person = await makeCustomer();
            const denied = new ShippingService(customers, parcels, shipments, { isAllowed: async () => false });
            await expect(denied.createShipment(makeRequest(person, await makeParcel())))
                .rejects.toBeInstanceOf(ShipmentRejectedError);
            expect(await shipments.findShipments(person.id, S.REGISTERED)).toEqual([]);
        }
    },
    {
        name: "[SMOKE] Повторне скасування не змінює відправлення",
        run: async () => {
            const saved = await service.createShipment(makeRequest(await makeCustomer(), await makeParcel()));
            const cancelled = await service.cancel(saved.id);
            await expect(service.cancel(saved.id)).rejects.toBeInstanceOf(ShipmentRejectedError);
            expect(await shipments.findById(saved.id)).toEqual(cancelled);
        }
    }
];

for (const scenario of scenarios) {
    test(scenario.name, scenario.run);
}
