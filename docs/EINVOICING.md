# E-invoicing

ServiceFlow creates structured e-invoices from **issued** invoices and credit notes. It always uses the data frozen at issue time, so an e-invoice never disagrees with the PDF.

| Business country | Scheme | What happens |
|---|---|---|
| India | GST e-invoice (IRN), NIC schema 1.1 | B2B invoices and credit notes are registered with the Invoice Registration Portal (IRP) through a provider. The IRN, acknowledgement and signed QR code are printed on the invoice PDF. |
| Other countries | EN 16931 UBL 2.1: Peppol BIS Billing 3.0 | XML download, or sending through a Peppol Access Point |
| Germany, or a German buyer | XRechnung 3.0 (CIUS of EN 16931) | Same as above, with German rules: Leitweg-ID, seller contact, IBAN |

Each invoice page has an **E-invoicing** panel. It shows what is missing, for example a GSTIN, an HSN/SAC code, a postcode or a Leitweg-ID, before anything is submitted. Every submission and its outcome is kept in `einvoice_documents`.

## India (IRN)

1. **Settings → Business:** set the legal name, address and 6-digit PIN code. **Settings → Regional:** set the GSTIN as the tax registration number.
2. **Customers:** business buyers need a GSTIN and a billing address with a PIN code. Customers without a GSTIN are B2C, and B2C invoices are not e-invoiced.
3. **Invoice lines** need an HSN/SAC code: 4, 6 or 8 digits.
4. **Integrations → E-invoicing (India IRN):**
   - **Sandbox.** It generates IRNs with the official algorithm (SHA-256 of GSTIN + financial year + document type + number) and a QR code marked **TEST**. Nothing is sent to the IRP, so use it for training only.
   - **GSP.** Enter your GST Suvidha Provider's base URL, endpoint paths and credentials. GSP APIs differ, so test against your GSP's sandbox first. The adapter is in `server/src/integrations/einvoice.ts`.
5. Optional: **Settings → E-invoicing → register automatically** registers B2B invoices as soon as they are issued. Problems are sent to the billing team as alerts.

You can cancel an IRN within **24 hours** (an IRP rule). After that, issue a credit note, which is registered as a CRN that refers back to the original invoice.

E-way bills are not implemented.

## EU (Peppol BIS 3.0 / XRechnung)

1. **Settings → Regional:** VAT ID in EU format, for example `DE123456789`.
2. **Settings → E-invoicing:**
   - Your Peppol ID as `scheme:identifier`, for example `9930:DE123456789` or `0088:<GLN>`.
   - IBAN and BIC. XRechnung requires payment details.
3. **Customers:**
   - The Peppol ID of business buyers.
   - For German public-sector buyers, the **buyer reference (Leitweg-ID)**.
4. **Download XML** gives you a document to upload to a buyer's portal, for example ZRE/OZG-RE.
5. **Send via Peppol** needs **Integrations → Peppol**:
   - **Test** records the sending without transmitting anything.
   - **Access Point (REST)** POSTs the UBL to your certified Access Point provider. Confirm the request format with your provider; the adapter is in `server/src/integrations/einvoice.ts`.

Credit notes are exported as UBL `CreditNote` (type 381) referencing the original invoice. ServiceFlow credit notes are amount-based, so they are split across the invoice's tax rates in proportion to the original invoice.

## Validating the XML with the official tools

The automated tests check the arithmetic (EN 16931 rules BR-CO-10, BR-CO-15 and BR-CO-16), the required German fields, XML escaping and well-formedness. They do **not** run the official Schematron validators.

To run the official validator, use the KoSIT validator with the XRechnung configuration on your own machine (Java 11+):

1. Generate sample documents:

   ```bash
   EINVOICE_OUT_DIR=./einvoice-samples npm test -w server -- tests/einvoice.test.ts
   ```

2. Download `validator-1.5.0-distribution.zip` from https://github.com/itplr-kosit/validator/releases and `validator-configuration-xrechnung_3.0.2_*.zip` from https://github.com/itplr-kosit/validator-configuration-xrechnung/releases, and unzip both.

3. Run the validator:

   ```bash
   java -jar validationtool-1.5.0-standalone.jar -s scenarios.xml -r . -o report server/einvoice-samples/*.xml
   ```

For Peppol BIS, the OpenPEPPOL validation artefacts at https://github.com/OpenPEPPOL/peppol-bis-invoice-3 are the reference.
