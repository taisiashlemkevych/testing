3. Виявлені проблеми та виправлення
1. Order dependency — залежність від порядку тестів
Було:
await service.dispatch(shipmentId);


Стало:
const saved = await service.createShipment(
    makeRequest(person, await makeParcel())
);
await service.dispatch(saved.id);


Змінили: тест сам створює відправлення і використовує його ID.
2. Shared state — спільні тестові дані
Було:
new Customer(0, "REGRESSION-CUSTOMER", false)


Стало:
new Customer(0, `C-${randomUUID()}`, false)


Змінили: додали генерацію унікальних кодів через randomUUID().
3. Fixed wait — фіксоване очікування
Було:
await new Promise(resolve => setTimeout(resolve, 50));


Стало:
await waitForShipment(customerId, shipment => shipment !== null);


Змінили: замість очікування 50 мс тест перевіряє появу відправлення.
4. Невизначений порядок результатів БД
Було:
SELECT * FROM shipments WHERE customer_id = $1;


Стало:
SELECT * FROM shipments
WHERE customer_id = $1
ORDER BY id ASC;


Змінили: додали ORDER BY id ASC для визначеного порядку записів.