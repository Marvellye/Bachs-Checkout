#!/usr/bin/env python3
"""
Build the Postman v2.1 collection shipped with bachs-checkout.

Why generate instead of hand-writing: the official spec has ~100 operations. Generating keeps
paths, query params and sample bodies in sync with the docs; only the curated folders (the SDK
flow, the public checkout API, the card vault) are hand-written.

Usage:
    python3 tools/build-postman.py            # uses spec/bachs-openapi.json
    python3 tools/build-postman.py --fetch    # downloads the spec first

Reads : spec/bachs-openapi.json (gitignored; fetched from docs.bachs.io)
        tests/fixtures/*.json             (real captured responses, used as examples)
Writes: postman/Bachs-API.postman_collection.json
        postman/Bachs-Sandbox.postman_environment.json      (secret from .env, gitignored)
        postman/Bachs-Sandbox.postman_environment.example.json
        postman/Bachs-Live.postman_environment.example.json
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC_PATH = os.path.join(ROOT, "spec", "bachs-openapi.json")
SPEC_URL = "https://docs.bachs.io/docs/openapi/openapi.json"
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
OUT_DIR = os.path.join(ROOT, "postman")

METHODS = ("get", "post", "put", "patch", "delete")

# Folder order: the paths a developer walks, not alphabetical.
FOLDER_ORDER = [
    "SDK Flow: create the payment",
    "Custom UI: drive the checkout (public API)",
    "Card vault (direct card data)",
    "Products",
    "Checkout Sessions",
    "Payments",
    "Customers",
    "Customer sessions",
    "Subscriptions",
    "Refunds",
    "Disputes",
    "Balances",
    "Conversions",
    "Payouts",
    "Transfers",
    "Platform Fees",
    "Virtual Accounts",
    "Accounts",
    "Connected Accounts",
    "Persons",
    "Media",
    "Reference",
    "Misc",
    "Webhooks",
]

FOLDER_BLURB = {
    "Products": "Your catalog. A checkout session cannot exist without at least one product.",
    "Checkout Sessions": "Server-side session creation. This is the ONLY place amounts become tamper-proof: the amount lives on the session, never in the browser.",
    "Payments": "Read-only payment records (a payment is never created directly) plus POST /v1/charges for off-session charges against a card already saved at a checkout.",
    "Webhooks": "Endpoint CRUD, delivery inspection and replay. Source of truth for fulfilment - never the browser event.",
}

# Sample IDs in the spec examples -> collection variables.
ID_REWRITES = [
    (r"\bacct_[A-Za-z0-9]+", "{{account_id}}"),
    (r"\bprod_[A-Za-z0-9]+", "{{product_id}}"),
    (r"\bcust_[A-Za-z0-9]+", "{{customer_id}}"),
    (r"\bchk_[A-Za-z0-9]+", "{{checkout_id}}"),
    (r"\bsub_[A-Za-z0-9]+", "{{subscription_id}}"),
    (r"\bref_[A-Za-z0-9]+", "{{refund_id}}"),
    (r"\binv_[A-Za-z0-9]+", "{{invoice_id}}"),
    (r"\bdisp_[A-Za-z0-9]+", "{{dispute_id}}"),
    (r"\bva_[A-Za-z0-9]+", "{{virtual_account_id}}"),
    (r"\bevt_[A-Za-z0-9]+", "{{event_id}}"),
    (r"\bwhsec_[A-Za-z0-9]+", "{{webhook_secret}}"),
    (r"\busr_[A-Za-z0-9]+", "{{user_id}}"),
    (r"\bpay_[A-Za-z0-9]+", "{{payment_id}}"),
    (r"\bch_(?!k)[A-Za-z0-9]+", "{{payment_id}}"),
    (r"\btrf_[A-Za-z0-9]+", "{{transfer_id}}"),
    (r"\bfee_[A-Za-z0-9]+", "{{fee_id}}"),
    (r"\bupl_[A-Za-z0-9]+", "{{upload_id}}"),
    (r"\bdest_[A-Za-z0-9]+", "{{destination_id}}"),
    (r"[\w.+-]+@example\.com", "{{customer_email}}"),
    (r"https://yourapp\.com/success", "{{success_url}}"),
    (r"https://yourapp\.com/cancel", "{{cancel_url}}"),
    (r"https://yoursite\.com/success", "{{success_url}}"),
    (r"https://yoursite\.com/cancelled", "{{cancel_url}}"),
    (r"https://shop\.example\.com/thanks", "{{success_url}}"),
    (r"https://shop\.example\.com/cart", "{{cancel_url}}"),
]

# Response id field -> collection variable it gets saved into.
CAPTURE_MAP = {
    "id": None,  # prefix-dependent, resolved below
    "checkout_id": "checkout_id",
    "product_id": "product_id",
    "group_id": "product_group_id",
    "customer_id": "customer_id",
    "payment_id": "payment_id",
    "charge_id": "payment_id",
    "refund_id": "refund_id",
    "dispute_id": "dispute_id",
    "subscription_id": "subscription_id",
    "account_id": "account_id",
    "transfer_id": "transfer_id",
    "withdrawal_id": "payout_id",
    "destination_id": "destination_id",
    "endpoint_id": "webhook_endpoint_id",
    "event_id": "event_id",
    "upload_id": "upload_id",
    "fee_id": "fee_id",
    "person_id": "person_id",
    "virtual_account_id": "virtual_account_id",
    "invoice_id": "invoice_id",
}

PREFIX_TO_VAR = {
    "prod": "product_id",
    "chk": "checkout_id",
    "cust": "customer_id",
    "pay": "payment_id",
    "ref": "refund_id",
    "disp": "dispute_id",
    "sub": "subscription_id",
    "acct": "account_id",
    "trf": "transfer_id",
    "fee": "fee_id",
    "upl": "upload_id",
    "evt": "event_id",
    "grp": "product_group_id",
}


def load_spec():
    with open(SPEC_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def deref(spec, schema, depth=0):
    """Resolve a local $ref one level at a time (guards against cycles)."""
    if not isinstance(schema, dict) or depth > 6:
        return schema or {}
    if "$ref" in schema:
        ref = schema["$ref"].lstrip("#/").split("/")
        node = spec
        for part in ref:
            node = node.get(part, {})
        return deref(spec, node, depth + 1)
    if "allOf" in schema:
        merged = {"type": "object", "properties": {}, "required": []}
        for sub in schema["allOf"]:
            sub = deref(spec, sub, depth + 1)
            merged["properties"].update(sub.get("properties", {}))
            merged["required"].extend(sub.get("required", []))
            for key in ("example", "type"):
                if key in sub and key not in merged:
                    merged[key] = sub[key]
        merged.update({k: v for k, v in schema.items() if k not in ("allOf",)})
        return merged
    return schema


def rewrite(obj):
    """Swap spec sample IDs for Postman variables, recursively."""
    if isinstance(obj, str):
        out = obj
        for pattern, var in ID_REWRITES:
            out = re.sub(pattern, var, out)
        return out
    if isinstance(obj, list):
        return [rewrite(x) for x in obj]
    if isinstance(obj, dict):
        return {k: rewrite(v) for k, v in obj.items()}
    return obj


def sample_value(spec, schema, name=""):
    """Generate a plausible example body field when the spec has no example."""
    schema = deref(spec, schema)
    if "example" in schema:
        return rewrite(schema["example"])
    if schema.get("enum"):
        return schema["enum"][0]
    if schema.get("default") is not None:
        return schema["default"]
    t = schema.get("type")
    if t == "object" or "properties" in schema:
        return {k: sample_value(spec, v, k) for k, v in schema.get("properties", {}).items()
                if k in schema.get("required", [])}
    if t == "array":
        item = sample_value(spec, schema.get("items", {}), name)
        return [item] if item is not None else []
    if t in ("number", "integer"):
        return 1
    if t == "boolean":
        return True
    if name.endswith("_url"):
        return "{{success_url}}"
    if name in ("email",):
        return "{{customer_email}}"
    if name.endswith("_id"):
        return "{{%s}}" % name
    if name in ("currency",):
        return "USD"
    if name in ("amount",):
        return "1.00"
    return "string"


def request_body(spec, op):
    rb = op.get("requestBody", {})
    content = rb.get("content", {})
    if not content:
        return None, None
    ctype = "application/json" if "application/json" in content else next(iter(content))
    media = content[ctype]
    if "example" in media:
        body = rewrite(media["example"])
    elif media.get("examples"):
        first = next(iter(media["examples"].values()))
        body = rewrite(deref(spec, first).get("value", {}))
    else:
        body = sample_value(spec, media.get("schema", {}))
    return ctype, body


def response_schema(spec, op):
    for code, resp in op.get("responses", {}).items():
        if str(code).startswith("2"):
            media = resp.get("content", {}).get("application/json")
            if media:
                return code, deref(spec, media.get("schema", {}))
    return None, None


def capture_script(spec, op):
    code, schema = response_schema(spec, op)
    if not schema:
        return None
    props = schema.get("properties", {}) or {}
    lines = []
    for prop, sub in props.items():
        if prop not in CAPTURE_MAP:
            continue
        var = CAPTURE_MAP[prop]
        if var is None:
            # Generic "id": derive the variable from the value's prefix at runtime.
            prefixes = ", ".join('%s: "%s"' % (k, v) for k, v in PREFIX_TO_VAR.items())
            lines.append(
                'const prefixes = { %s };\n'
                'const prefix = String(body.id).split("_")[0];\n'
                'if (prefixes[prefix]) { pm.collectionVariables.set(prefixes[prefix], body.id); }'
                % prefixes
            )
        else:
            expr = "body.%s" % prop
            lines.append('if (%s) { pm.collectionVariables.set("%s", %s); }' % (expr, var, expr))
        # nested object one level deep (e.g. charge.payment_id, customer.id)
        sub_d = deref(spec, sub)
        for child, child_schema in (sub_d.get("properties") or {}).items():
            if child.endswith("_id") and child in CAPTURE_MAP and CAPTURE_MAP[child]:
                expr = "body.%s && body.%s.%s" % (prop, prop, child)
                lines.append('if (%s) { pm.collectionVariables.set("%s", %s); }'
                             % (expr, CAPTURE_MAP[child], expr))
    if not lines:
        return None
    head = 'const body = pm.response.json();\n'
    tail = ('\npm.test("captured ids from response", function () { pm.expect(true).to.be.true; });')
    return '// Persist this response\'s ids so later requests can chain.\n' + head + "\n".join(lines) + tail


def build_params(spec, op, path):
    params = []
    for raw in op.get("parameters", []):
        p = deref(spec, raw)
        if p.get("in") not in ("path", "query"):
            continue
        name = p["name"]
        if p["in"] == "path":
            value = "{{%s}}" % name
        else:
            schema = p.get("schema", {})
            value = schema.get("default", schema.get("example", ""))
            if value == "" and schema.get("enum"):
                value = schema["enum"][0]
            if value == "" and name.lower() in ("limit", "page_size"):
                value = 10
            value = str(value)
        params.append({
            "key": name,
            "value": value,
            "type": "string",
            "description": p.get("description", "")[:400],
        })
    return params


def clean_path(path):
    """MSYS/markdown noise is not a thing here, but drop any template braces Postman rejects."""
    return re.sub(r"\{(.+?)\}", r"{{\1}}", path)


def build_item(spec, method, path, op):
    ctype, body = request_body(spec, op)
    url_path = clean_path(path)
    segments = [s for s in url_path.strip("/").split("/")]
    params = build_params(spec, op, path)
    query = [p for p in params if p["key"] in [x["name"] for x in op.get("parameters", [])
                                               if deref(spec, x).get("in") == "query"]]

    raw_query = "&".join("%s=%s" % (q["key"], q["value"]) for q in query)
    raw = "{{baseUrl}}/" + "/".join(segments)
    if raw_query:
        raw += "?" + raw_query

    headers = []
    if body is not None:
        headers.append({"key": "Content-Type", "value": ctype})

    item = {
        "name": op.get("summary") or "%s %s" % (method.upper(), path),
        "request": {
            "method": method.upper(),
            "header": headers,
            "url": {
                "raw": raw,
                "host": ["{{baseUrl}}"],
                "path": segments,
                "query": query,
            },
            "description": (op.get("description") or "").strip()[:2000],
        },
        "response": [],
    }
    if body is not None:
        item["request"]["body"] = {
            "mode": "raw",
            "raw": json.dumps(body, indent=2),
            "options": {"raw": {"language": "json"}},
        }

    # Tests: expected status + id capture.
    code, schema = response_schema(spec, op)
    tests = ['pm.test("HTTP " + pm.response.code + " is a success", function () {\n'
             '    pm.expect(pm.response.code).to.be.oneOf([200, 201, 202, 204]);\n'
             '});']
    if code:
        tests.insert(0, 'pm.test("expected %s", function () { pm.expect(pm.response.code).to.eql(%s); });'
                     % (code, code))
    if schema and schema.get("properties"):
        tests.append('pm.test("response is JSON", function () {\n'
                     '    pm.response.to.be.json;\n'
                     '});')
    cap = capture_script(spec, op)
    if cap:
        tests.append(cap)
    item["event"] = [{"listen": "test", "script": {"type": "text/javascript", "exec": tests[-1].split("\n")}}]
    # keep all tests, not just the last one
    exec_lines = []
    for t in tests:
        exec_lines.extend(t.split("\n"))
        exec_lines.append("")
    item["event"][0]["script"]["exec"] = exec_lines
    return item


# --------------------------------------------------------------------------
# Curated folders. These are hand-written because they document the *public*
# checkout API, which is not in the OpenAPI spec: it is the surface the hosted
# checkout page itself calls (recovered from the checkout bundle).
# --------------------------------------------------------------------------

PUBLIC = "/v1/public/checkouts/{{checkout_token}}"
CHECKOUT_ORIGIN = "{{checkoutOrigin}}"
CARD_ACTIONS = {
    "mintTokenizeGrant": "401e47952554c1841a2eea4c949c0d9a2bc472aabb",
    "tokenizeCardWithGrantRetry": "70008f5fa5e47a0ac1ecaf0bd9276d63aed5d690a9",
    "completeCardCheckout": "78c10d5fadf85ecdb798e781a46ace709ca32ee329",
    "authorizeCardStep": "601d19c6512a8e072046ffb28cec658c7461c0d371",
    "authorizePinViaVault": "609fb1f9e88b842d448abfa03c92b5143cce7a61fc",
}


def load_fixture(name):
    """Real response shapes captured from the sandbox, kept in tests/fixtures (sanitised)."""
    path = os.path.join(FIXTURES, name)
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def example(name, body, code=200):
    """Attach a saved example response so the collection documents real output."""
    return {
        "name": name,
        "originalRequest": {"method": "POST", "header": [], "url": {"raw": "", "host": [""], "path": [""]}},
        "status": "OK" if code < 300 else "Error",
        "code": code,
        "header": [{"key": "content-type", "value": "application/json"}],
        "cookie": [],
        "body": json.dumps(body, indent=2) if not isinstance(body, str) else body,
        "_postman_previewlanguage": "json",
    }


def req_item(name, method, path, body=None, desc="", query=None, headers=None, tests=None,
             examples=None, host="{{baseUrl}}"):
    host_path = path.lstrip("/").split("/")
    url = {"raw": host + "/" + path.lstrip("/"), "host": [host], "path": host_path}
    if query:
        url["query"] = query
        url["raw"] += "?" + "&".join("%s=%s" % (q["key"], q["value"]) for q in query)

    item = {
        "name": name,
        "request": {"method": method, "header": list(headers or []), "url": url, "description": desc},
        "response": examples or [],
    }
    if body is not None:
        item["request"]["header"].append({"key": "Content-Type", "value": "application/json"})
        item["request"]["body"] = {"mode": "raw", "raw": json.dumps(body, indent=2),
                                   "options": {"raw": {"language": "json"}}}
    if tests:
        lines = []
        for t in tests:
            lines.extend(t.split("\n"))
            lines.append("")
        item["event"] = [{"listen": "test", "script": {"type": "text/javascript", "exec": lines}}]
    return item


def create_payment_folder():
    """Private API: the server-side calls that mint the payment request."""
    tests_capture_product = [
        'pm.test("product created", () => pm.expect(pm.response.code).to.eql(201));',
        'const b = pm.response.json();\npm.collectionVariables.set("product_id", b.id);',
    ]
    tests_capture_session = [
        'pm.test("session open", () => pm.expect(pm.response.code).to.eql(201));',
        'const b = pm.response.json();\n'
        'pm.collectionVariables.set("checkout_id", b.checkout_id);\n'
        'pm.collectionVariables.set("checkout_url", b.checkout_url);\n'
        'pm.collectionVariables.set("checkout_token", b.checkout_url.replace(/\\/$/,"").split("/").pop());',
        'console.log("public checkout: " + pm.response.json().checkout_url);',
    ]

    items = [
        req_item("1. Create product (catalog item)", "POST", "/v1/products", {
            "name": "SDK Test Item",
            "description": "Created by the Postman flow - safe to archive.",
            "price": {"price_type": "fixed", "currency": "USD", "amount": "1.00"},
            "metadata": {"source": "postman-flow"},
        }, "A checkout session always prices off a product. Skip if you already have {{product_id}}.",
            tests=tests_capture_product),
        req_item("2. Create checkout session  ->  the payment request", "POST", "/v1/checkout-sessions", {
            "product_cart": [{"product_id": "{{product_id}}", "quantity": 1}],
            "customer": {"email": "{{customer_email}}", "name": "{{customer_name}}"},
            "success_url": "{{success_url}}",
            "cancel_url": "{{cancel_url}}",
            "reference": "LAB-{{$timestamp}}",
            "metadata": {"source": "postman-flow"},
        },
            "Server-side only, secret key. Returns checkout_url + client_secret. The token segment of "
            "checkout_url is the credential for every call in the next folder - it needs no API key, "
            "which is why your browser can drive the checkout without seeing your secret.\n\n"
            "Optional: add \"payment_method_types\": [\"USD_CARD\", \"NGN_CARD\"] to restrict the rails "
            "offered - note it is enforced server-side, so a rail you exclude returns "
            "PAYMENT_METHOD_NOT_ALLOWED later.",
            tests=tests_capture_session),
        req_item("2b. Create checkout session - RAW AMOUNT (no product)", "POST", "/v1/checkout-sessions", {
            "pricing": {"currency": "USD", "amount": "{{amount}}"},
            "customer": {"email": "{{customer_email}}", "name": "{{customer_name}}"},
            "success_url": "{{success_url}}",
            "cancel_url": "{{cancel_url}}",
            "reference": "RAW-{{$timestamp}}",
            "metadata": {"source": "postman-raw-amount"},
        },
            "Product-less session: `pricing` replaces `product_cart` and they are mutually exclusive. The "
            "detail response then carries `products: null` and the amount you set here is the amount charged. "
            "Minimums apply for some currencies (NGN needs at least 100.00).",
            tests=['pm.test("product-less session open", () => pm.expect(pm.response.code).to.eql(201));',
                   'const b = pm.response.json();\n'
                   'pm.collectionVariables.set("checkout_id", b.checkout_id);\n'
                   'pm.collectionVariables.set("checkout_url", b.checkout_url);\n'
                   'pm.collectionVariables.set("checkout_token", b.checkout_url.replace(/\\/$/,"").split("/").pop());']),

        req_item("2c. Create checkout session - BUYER-CHOSEN amount (custom pricing)", "POST", "/v1/checkout-sessions", {
            "pricing": {"currency": "USD", "price_type": "custom",
                        "preset_amount": "5.00", "minimum_amount": "1.00", "maximum_amount": "50.00"},
            "customer": {"email": "{{customer_email}}"},
            "success_url": "{{success_url}}",
            "cancel_url": "{{cancel_url}}",
        },
            "Pay-what-you-want, still product-less. The buyer picks the amount within your bounds; you can also "
            "set it server-side with the set-amount call in the next folder.",
            tests=['pm.test("custom session open", () => pm.expect(pm.response.code).to.eql(201));',
                   'const b = pm.response.json();\n'
                   'pm.collectionVariables.set("checkout_id", b.checkout_id);\n'
                   'pm.collectionVariables.set("checkout_token", b.checkout_url.replace(/\\/$/,"").split("/").pop());']),

        req_item("2d. Create checkout session - FREE (no charge)", "POST", "/v1/checkout-sessions", {
            "pricing": {"currency": "USD", "price_type": "free"},
            "customer": {"email": "{{customer_email}}"},
            "success_url": "{{success_url}}",
            "cancel_url": "{{cancel_url}}",
        },
            "Amount 0.00 and `payment_required: false`. Completing it returns payment_type=redirect with "
            "a payment_url, and the session lands on completed - useful for trials and comped access.",
            tests=['pm.test("free session open", () => pm.expect(pm.response.code).to.eql(201));',
                   'const b = pm.response.json();\n'
                   'pm.collectionVariables.set("checkout_id", b.checkout_id);\n'
                   'pm.collectionVariables.set("checkout_token", b.checkout_url.replace(/\\/$/,"").split("/").pop());']),

        req_item("2e. Create checkout session - CATALOG with per-line price override", "POST", "/v1/checkout-sessions", {
            "product_cart": [{"product_id": "{{product_id}}", "quantity": 1,
                              "pricing": {"price_type": "fixed", "amount": "19.00"}}],
            "customer": {"email": "{{customer_email}}"},
        },
            "Middle ground: keep the catalog product, override the price for this one session. The catalog is "
            "untouched and the override is never added to the price list."),

        req_item("3. Get checkout session (server view)", "GET", "/v1/checkout-sessions/{{checkout_id}}", None,
                 "Full session object once the customer has paid: charge, fees, customer_details."),
        req_item("4. Reconcile: list payments", "GET", "/v1/payments", None,
                 "What actually settled, with fees and refunds. Filter by reference/status/date.",
                 query=[{"key": "limit", "value": "10"},
                        {"key": "status", "value": "", "description": "succeeded | failed | pending"}]),
        req_item("5. Charge a saved card (off-session)", "POST", "/v1/charges", {
            "customer": "{{customer_id}}",
            "amount": "5.00",
            "currency": "USD",
            "description": "Usage top-up",
            "reference": "USAGE-{{$timestamp}}",
        }, "No page, no customer present: needs a card already saved at a previous checkout "
           "(save_payment_method: true). Always returns a payment - a refusal is in status, not an error."),
        req_item("6. Refund a payment", "POST", "/v1/refunds", {
            "charge_id": "{{payment_id}}",
            "amount": "1.00",
            "reason": "Sandbox test refund",
            "reference": "RF-{{$timestamp}}",
        }, "Refunds settle asynchronously; refund.paid confirms delivery."),
    ]
    return {
        "name": "SDK Flow: create the payment",
        "description": "Server side, secret key. Creates the catalog item and the checkout session, then "
                       "reads the settled money back. Nothing here touches a customer's browser.",
        "item": items,
    }


def public_checkout_folder():
    """Public API: what the hosted checkout page calls. Recovered from the checkout bundle."""
    bank = load_fixture("bank.json")
    crypto_ex = load_fixture("crypto.json")
    momo_ex = load_fixture("momo.json")
    card_ex = load_fixture("card.json")

    def ex(captured, key, name, code=200):
        if not captured or key not in captured or captured[key] is None:
            return []
        return [example(name, captured[key], code)]

    items = [
        req_item("1. Detail: amount, rails, branding", "GET", PUBLIC + "/detail", None,
                 "Everything a checkout screen renders: amount, currency, payment_methods (with the "
                 "currencies each corridor accepts), customer, success/cancel URLs.",
                 tests=['const b = pm.response.json();\n'
                        'console.log(b.payment_methods.map(m => m.payment_method).join(", "));',
                        'pm.test("session readable without an API key", () => pm.expect(pm.response.code).to.eql(200));']),

        req_item("1b. Set amount (custom pricing)", "POST", PUBLIC + "/set-amount",
                 {"amount": "{{custom_amount}}"},
                 "Buyer picked a number on your own UI: push it here before quoting. Only valid while the "
                 "session price_type is custom and the amount sits inside minimum/maximum.",
                 tests=['const b = pm.response.json();\n'
                        'console.log("amount now", b.amount, b.currency);',
                        'pm.test("amount accepted", () => pm.expect(pm.response.code).to.eql(200));']),

        req_item("2a. Requirements: bank transfer", "POST", PUBLIC + "/requirements",
                 {"payment_method": "NGN_BANK_TRANSFER", "currency": "NGN"},
                 "The API tells you which fields this rail needs next and names the endpoint to call. "
                 "Bank transfer needs nothing, so next_step is get-quote.",
                 examples=ex(bank, "requirements", "200 - next step: get-quote")),

        req_item("2b. Requirements: mobile money returns a network list", "POST", PUBLIC + "/requirements",
                 {"payment_method": "MOMO_GHS", "currency": "GHS"},
                 "Momo is a two-step rail: pick the network (mtn / vodafone / ...) from this response, "
                 "then quote with payment_rail. A second requirements call after the quote asks for the phone number.",
                 examples=ex(momo_ex, "requirements_step1", "200 - dynamic form: payment_rail select")),

        req_item("3. Quote: lock the rate and fee", "POST", PUBLIC + "/get-quote",
                 {"payment_method": "NGN_BANK_TRANSFER", "currency": "NGN"},
                 "Returns quote_id, the local amount, the processing fee and the exchange rate. Quotes are "
                 "short-lived (minutes) - re-quote rather than retrying a stale one.",
                 tests=['const b = pm.response.json();\n'
                        'if (b.quote_id) pm.collectionVariables.set("quote_id", b.quote_id);\n'
                        'console.log(b.total_amount, b.currency, "fee", b.processing_fee);'],
                 examples=ex(bank, "get_quote", "200 - quote_id + local amount")),

        req_item("4a. Complete: bank transfer  ->  account number", "POST", PUBLIC + "/complete",
                 {"payment_method": "NGN_BANK_TRANSFER", "quote_id": "{{quote_id}}"},
                 "Returns payment_type=instructions with the real account name, number, bank, the amount "
                 "expected and an expiry. polling_required tells you to watch /charges/{id}/status.",
                 tests=['const b = pm.response.json();\n'
                        'if (b.charge_id) pm.collectionVariables.set("charge_id", b.charge_id);\n'
                        'console.log(JSON.stringify(b.instructions));'],
                 examples=ex(bank, "complete", "200 - payment_type: instructions")),

        req_item("4b. Complete: crypto  ->  address + countdown", "POST", PUBLIC + "/complete",
                 {"payment_method": "CRYPTO", "quote_id": "{{quote_id}}"},
                 "Returns the deposit address, network, exact crypto amount, a base64 PNG QR code and "
                 "expires_in_minutes for the on-screen timer.",
                 examples=ex(crypto_ex, "complete", "200 - address, network, qr_code, 60 min timer")),

        req_item("4c. Complete: mobile money  ->  approve on phone", "POST", PUBLIC + "/complete",
                 {"payment_method": "MOMO_GHS", "quote_id": "{{quote_id}}",
                  "payment_rail": "mtn", "phone_number": "{{phone_number}}"},
                 "Phone must be +countrycode or 7-10 local digits. Returns instructions.action="
                 "approve_on_phone: render a prompt screen and poll.",
                 examples=ex(momo_ex, "complete", "200 - approve_on_phone")),

        req_item("4d. Complete: card (USD)  ->  Stripe client_secret", "POST", PUBLIC + "/complete",
                 {"payment_method": "USD_CARD", "quote_id": "{{quote_id}}"},
                 "Inline card rail. Returns payment_type=inline with a Stripe PaymentIntent client_secret: "
                 "confirm it with Stripe.js/Elements in your own form. (This sandbox account settles USD cards "
                 "through a processor instead - see the vault actions at the bottom for the direct path.)",
                 examples=ex(card_ex, "complete_inline", "200 - payment_type: inline")),

        req_item("4e. Complete: card (NGN)  ->  processor, then poll", "POST", PUBLIC + "/complete",
                 {"payment_method": "NGN_CARD", "quote_id": "{{quote_id}}"},
                 "Local card rail: no client_secret, payment_type=processing. The customer approves with the "
                 "issuer (OTP / in-app) and you follow the charge status."),

        req_item("5. Charge status: poll until terminal", "GET", PUBLIC + "/charges/{{charge_id}}/status",
                 None,
                 "charge_status (open/paid/failed), substatus, attempt_status, failure_message/failure_code, "
                 "redirect_url and amount_paid/amount_remaining. This is the state machine your UI renders.",
                 tests=['const b = pm.response.json();\n'
                        'console.log(b.charge_status, b.substatus, b.attempt_status);',
                        'pm.test("terminal or pending", () => pm.expect(b.charge_status).to.be.a("string"));']),

        req_item("6. Mobile money: submit the approval code", "POST", PUBLIC + "/mobile-money/authorize",
                 {"code": "{{momo_code}}"},
                 "Only when the network returns requires_otp rather than approve_on_phone. The sandbox "
                 "prompt usually auto-approves, so this is a production path."),

        req_item("7. Card: confirm with a token from elsewhere", "POST", PUBLIC + "/confirm-payment",
                 {"payment_token": "{{card_token}}"},
                 "Alternative to the vault: if you already minted a card token, hand it over here."),
    ]
    return {
        "name": "Custom UI: drive the checkout (public API)",
        "description": "No secret key: the checkout token is the credential. This is the surface the hosted "
                       "checkout page calls, so your own UI can render every rail itself - account numbers, "
                       "wallet addresses with timers, QR codes, momo prompts - with no redirect.",
        "item": items,
    }


def card_vault_folder():
    """The direct card path: RSA-sealed card data submitted through the checkout's own actions."""
    base_headers = [
        {"key": "Content-Type", "value": "text/plain;charset=UTF-8"},
        {"key": "Accept", "value": "text/x-component"},
        {"key": "Origin", "value": "{{checkoutOrigin}}"},
    ]

    def action_item(name, action, args, desc, extra_headers=None):
        headers = list(base_headers) + [{"key": "Next-Action", "value": CARD_ACTIONS[action]}]
        if extra_headers:
            headers.extend(extra_headers)
        return req_item(name, "POST", "/c/{{checkout_token}}", args, desc,
                        headers=headers, host="{{checkoutOrigin}}")

    items = [
        req_item("0. Vault public key (RSA-OAEP-256)", "GET", "/api/vault/public-key", None,
                 "Serve-side of the checkout origin. Import the SPKI PEM, encrypt an AES-256-GCM key with "
                 "RSA-OAEP-SHA256, seal the card JSON. The SDK's CardVault.seal() does exactly this.",
                 headers=[{"key": "User-Agent", "value": "bachs-postman/0.1"}],
                 host="{{checkoutOrigin}}"),
        action_item("1. mintTokenizeGrant", "mintTokenizeGrant", ["{{checkout_token}}"],
                    "Mints a short-lived grant (120s) that authorises one tokenization. Body is the argument "
                    "array. Response carries {grant, expires_in, collect_pin}."),
        action_item("2. tokenizeCardWithGrantRetry", "tokenizeCardWithGrantRetry",
                    ["{{checkout_token}}", "{{vault_grant}}", "{{sealed_card}}"],
                    "Send the sealed card: {encrypted_key, iv, ciphertext} (base64). Returns a vault handle "
                    "like vlt_... plus brand and last4. The PAN never appears in the response."),
        action_item("3. completeCardCheckout", "completeCardCheckout",
                    ["{{checkout_token}}", "{{card_handle}}", "{{quote_id}}", {}],
                    "Fires the card payment. Then poll the public charge-status endpoint for the outcome."),
        action_item("4. authorizeCardStep (OTP)", "authorizeCardStep",
                    ["{{checkout_token}}", {"code": "{{otp_code}}"}],
                    "Issuer asked for an OTP (next_action.type = requires_otp)."),
        action_item("5. authorizePinViaVault (PIN)", "authorizePinViaVault",
                    ["{{checkout_token}}", {"code": "{{card_pin}}"}],
                    "Some NGN cards require a PIN after tokenization (grant.collect_pin = true)."),
    ]
    return {
        "name": "Card vault (direct card data)",
        "description": "The checkout page's own card path, callable from your server: card data sealed with "
                       "the vault's public key, then Next.js server actions on the checkout origin. "
                       "These action ids belong to a build - if Bachs redeploys the checkout, refresh them "
                       "from the bundle. Prefer the inline Stripe rail when it is available.",
        "item": items,
    }


def build_collection(spec):
    folders = {}
    for path, item in spec["paths"].items():
        for method in METHODS:
            if method not in item:
                continue
            op = item[method]
            tag = (op.get("tags") or ["Misc"])[0]
            folders.setdefault(tag, []).append(build_item(spec, method, path, op))

    curated = {
        "SDK Flow: create the payment": create_payment_folder,
        "Custom UI: drive the checkout (public API)": public_checkout_folder,
        "Card vault (direct card data)": card_vault_folder,
    }
    ordered = []
    for name in FOLDER_ORDER:
        if name in curated:
            ordered.append(curated[name]())
            continue
        if name in folders:
            ordered.append({
                "name": name,
                "description": FOLDER_BLURB.get(name, ""),
                "item": folders.pop(name),
            })
    for name, items in folders.items():  # anything the spec added later
        ordered.append({"name": name, "description": "", "item": items})

    collection = {
        "info": {
            "_postman_id": "7d3f9c1e-4b2a-4f6d-9c8e-bachs-sdk-0001",
            "name": "Bachs Checkout (unofficial SDK)",
            "description": (
                "Generated from the official Bachs OpenAPI spec (spec/bachs-openapi.json), plus a curated "
                "SDK Flow folder.\n\n"
                "**Auth:** collection-level Bearer {{BACHS_SECRET_KEY}}. Pick an environment "
                "(Sandbox / Live) - the key and baseUrl swap together, nothing else changes.\n\n"
                "**Money:** always a decimal string at currency precision, paired with an ISO 4217 code. "
                "Never minor units.\n\n"
                "**Idempotency:** the collection pre-request script attaches an Idempotency-Key to every "
                "POST/PATCH automatically, as the API requires.\n\n"
                "**Truth:** fulfilment comes from the collection.succeeded webhook, never from the browser "
                "or from a 201 response."
            ),
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{BACHS_SECRET_KEY}}", "type": "string"}]},
        "item": ordered,
        "event": [
            {
                "listen": "prerequest",
                "script": {
                    "type": "text/javascript",
                    "exec": [
                        "// Bachs requires Idempotency-Key on public writes. Auto-generate one per request.",
                        "const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'];",
                        "if (mutating.includes(pm.request.method) && !pm.request.headers.has('Idempotency-Key')) {",
                        "    pm.request.headers.add({",
                        "        key: 'Idempotency-Key',",
                        "        value: 'pm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)",
                        "    });",
                        "}",
                    ],
                },
            },
            {
                "listen": "test",
                "script": {
                    "type": "text/javascript",
                    "exec": [
                        "pm.test('responds in under 10s', function () {",
                        "    pm.expect(pm.response.responseTime).to.be.below(10000);",
                        "});",
                        "// Bachs error envelope: { detail, ... }. Surface it instead of a bare status code.",
                        "if (pm.response.code >= 400) {",
                        "    let detail = pm.response.text();",
                        "    try { detail = JSON.stringify(pm.response.json(), null, 2); } catch (e) {}",
                        "    console.warn('Bachs error ' + pm.response.code + ': ' + detail);",
                        "}",
                    ],
                },
            },
        ],
        "variable": [
            {"key": "baseUrl", "value": "https://sandbox-api.bachs.io", "type": "string"},
            {"key": "BACHS_SECRET_KEY", "value": "", "type": "secret"},
            {"key": "product_id", "value": "", "type": "string"},
            {"key": "checkout_id", "value": "", "type": "string"},
            {"key": "checkout_url", "value": "", "type": "string"},
            {"key": "checkoutOrigin", "value": "https://sandbox-checkout.bachs.io", "type": "string"},
            {"key": "checkout_token", "value": "", "type": "string"},
            {"key": "quote_id", "value": "", "type": "string"},
            {"key": "amount", "value": "2.50", "type": "string"},
            {"key": "custom_amount", "value": "7.50", "type": "string"},
            {"key": "charge_id", "value": "", "type": "string"},
            {"key": "vault_grant", "value": "", "type": "secret"},
            {"key": "sealed_card", "value": "", "type": "secret"},
            {"key": "card_handle", "value": "", "type": "string"},
            {"key": "card_token", "value": "", "type": "string"},
            {"key": "phone_number", "value": "+233201234567", "type": "string"},
            {"key": "momo_code", "value": "", "type": "string"},
            {"key": "otp_code", "value": "", "type": "string"},
            {"key": "card_pin", "value": "", "type": "secret"},
            {"key": "customer_id", "value": "", "type": "string"},
            {"key": "customer_email", "value": "customer@example.com", "type": "string"},
            {"key": "customer_name", "value": "John Doe", "type": "string"},
            {"key": "payment_id", "value": "", "type": "string"},
            {"key": "refund_id", "value": "", "type": "string"},
            {"key": "subscription_id", "value": "", "type": "string"},
            {"key": "dispute_id", "value": "", "type": "string"},
            {"key": "account_id", "value": "", "type": "string"},
            {"key": "transfer_id", "value": "", "type": "string"},
            {"key": "payout_id", "value": "", "type": "string"},
            {"key": "destination_id", "value": "", "type": "string"},
            {"key": "webhook_endpoint_id", "value": "", "type": "string"},
            {"key": "event_id", "value": "", "type": "string"},
            {"key": "product_group_id", "value": "", "type": "string"},
            {"key": "virtual_account_id", "value": "", "type": "string"},
            {"key": "upload_id", "value": "", "type": "string"},
            {"key": "fee_id", "value": "", "type": "string"},
            {"key": "person_id", "value": "", "type": "string"},
            {"key": "invoice_id", "value": "", "type": "string"},
            {"key": "user_id", "value": "", "type": "string"},
            {"key": "webhook_secret", "value": "", "type": "secret"},
            {"key": "success_url", "value": "https://localhost.test/fund/success", "type": "string"},
            {"key": "cancel_url", "value": "https://localhost.test/fund/cancelled", "type": "string"},
        ],
    }
    return collection


def read_env():
    env = {}
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def environment(name, values, secret_keys=()):
    return {
        "name": name,
        "values": [
            {"key": k, "value": v, "type": "secret" if k in secret_keys else "default", "enabled": True}
            for k, v in values.items()
        ],
        "_postman_variable_scope": "environment",
    }


def fetch_spec():
    import urllib.request

    os.makedirs(os.path.dirname(SPEC_PATH), exist_ok=True)
    req = urllib.request.Request(SPEC_URL, headers={"User-Agent": "bachs-checkout-build"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = res.read()
    with open(SPEC_PATH, "wb") as fh:
        fh.write(data)
    print("fetched spec ->", SPEC_PATH, "(%d bytes)" % len(data))


def main():
    if "--fetch" in sys.argv:
        fetch_spec()
    if not os.path.exists(SPEC_PATH):
        sys.exit("spec/bachs-openapi.json is missing. Run: python3 tools/build-postman.py --fetch")

    os.makedirs(OUT_DIR, exist_ok=True)
    spec = load_spec()
    collection = build_collection(spec)

    coll_path = os.path.join(OUT_DIR, "Bachs-API.postman_collection.json")
    with open(coll_path, "w", encoding="utf-8") as fh:
        json.dump(collection, fh, indent=2, ensure_ascii=False)

    env = read_env()
    sandbox_values = {
        "baseUrl": "https://sandbox-api.bachs.io",
        "BACHS_SECRET_KEY": env.get("BACHS_SECRET_KEY", ""),
        "webhook_secret": env.get("BACHS_WEBHOOK_SECRET", ""),
        "success_url": env.get("BACHS_SUCCESS_URL", "https://example.com/paid"),
        "cancel_url": env.get("BACHS_CANCEL_URL", "https://example.com/cancelled"),
        "customer_email": "customer@example.com",
        "customer_name": "John Doe",
    }

    # A secret-bearing environment file is only useful locally; never emit one with an empty key.
    if sandbox_values["BACHS_SECRET_KEY"]:
        with open(os.path.join(OUT_DIR, "Bachs-Sandbox.postman_environment.json"), "w", encoding="utf-8") as fh:
            json.dump(environment("Bachs Sandbox", sandbox_values, ("BACHS_SECRET_KEY", "webhook_secret")),
                      fh, indent=2, ensure_ascii=False)
        print("wrote   : postman/Bachs-Sandbox.postman_environment.json (gitignored - contains your key)")
    else:
        print("skipped : Bachs-Sandbox.postman_environment.json (no BACHS_SECRET_KEY in .env)")

    example = dict(sandbox_values)
    example["BACHS_SECRET_KEY"] = "sk_sandbox_paste_your_key_here"
    example["webhook_secret"] = "whsec_paste_your_signing_secret_here"
    with open(os.path.join(OUT_DIR, "Bachs-Sandbox.postman_environment.example.json"), "w", encoding="utf-8") as fh:
        json.dump(environment("Bachs Sandbox (example)", example), fh, indent=2, ensure_ascii=False)

    live = dict(example)
    live.update({"baseUrl": "https://api.bachs.io",
                 "BACHS_SECRET_KEY": "sk_live_paste_your_key_here",
                 "webhook_secret": "whsec_paste_your_signing_secret_here"})
    with open(os.path.join(OUT_DIR, "Bachs-Live.postman_environment.example.json"), "w", encoding="utf-8") as fh:
        json.dump(environment("Bachs Live (example)", live), fh, indent=2, ensure_ascii=False)

    reqs = sum(len(f["item"]) for f in collection["item"])
    print("collection : %s" % coll_path)
    print("folders    : %d" % len(collection["item"]))
    print("requests   : %d" % reqs)
    print("empty items: %d" % sum(1 for f in collection["item"] for i in f["item"] if not i.get("request")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
