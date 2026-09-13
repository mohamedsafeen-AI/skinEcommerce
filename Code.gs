/**
 * ============================================================
 *  LUMINA SKINCARE — Google Apps Script Backend
 * ============================================================
 *  Spreadsheet:  Lumina Skincare Orders
 *  Tabs:         Users | Orders | Contact Messages | Reviews
 *
 *  Actions:
 *    ?action=signup            -> create user (duplicate email check, hashed password)
 *    ?action=login             -> verify credentials against Users sheet (admin gets token)
 *    ?action=order             -> save order to Orders sheet (+ confirmation email)
 *    ?action=contact           -> save contact message
 *    ?action=getOrders         -> admin: list all orders (aliases: admin_orders, getAdminOrders)
 *    ?action=getOrder          -> admin: fetch a single order by Order ID
 *    ?action=updateOrderStatus -> admin: update Status (+ Last Updated) in Google Sheets
 *    ?action=updateShipping    -> admin: update Courier + AWB in Google Sheets
 *    ?action=updateOrder       -> admin: update Status + Courier + AWB in ONE call (only provided fields are written)
 *    ?action=getDashboardStats -> admin: order counts + revenue (computed from sheet)
 *    ?action=getCustomers      -> admin: aggregated customer list (Users + Orders)
 *    ?action=getContactMessages-> admin: list contact messages
 *    ?action=trackOrder        -> customer: fetch a single order by Order ID
 *    ?action=myOrders          -> customer: all orders for the logged-in email
 *    ?action=googlelogin       -> verify a Google ID token, return/create the user
 *    ?action=getProductReviews -> public: approved reviews + average for a product
 *    ?action=getReviewEligibility -> customer: can this user review this product
 *    ?action=submitReview      -> customer: submit a review (saved as Pending)
 *    ?action=getReviews        -> admin: list all reviews
 *    ?action=updateReviewStatus-> admin: approve / reject / reopen a review
 *
 *  All endpoints return JSON:
 *    { "success": true|false, "message": "...", ... }
 *
 *  Google Sheets is the source of truth. Status changes are written to the
 *  Orders sheet only after validation, and never kept client-side only.
 * ============================================================
 */

var SPREADSHEET_NAME = "Lumina Skincare Orders";

var USERS_HEADERS = ["Timestamp", "User ID", "Name", "Email", "Password Hash", "Status", "Role"];

var ORDERS_HEADERS = [
  "Order ID", "Customer Name", "Phone", "Address", "Product", "Qty", "Amount",
  "Payment Status", "Order Status", "AWB", "Courier", "Created At",
  "Email", "User ID", "Product ID", "Payment Method", "Email Sent"
];

var CONTACT_HEADERS = ["Timestamp", "Name", "Email", "Subject", "Message", "Status"];

var REVIEWS_HEADERS = [
  "ReviewID", "ProductID", "OrderID", "CustomerEmail", "CustomerName",
  "Rating", "Comment", "Date", "Status"
];

var VALID_REVIEW_STATUSES = ["Pending", "Approved", "Rejected"];

var VALID_ORDER_STATUSES = ["Pending", "Processing", "Shipped", "Out for Delivery", "Delivered", "Cancelled"];

// Payment Status column values. COD orders start "Pending"; online (Cashfree)
// orders start "Initiated" and move to "Success" / "Failed" once verified,
// or can be adjusted manually by an admin.
var VALID_PAYMENT_STATUSES = ["Pending", "Initiated", "Success", "Failed"];

/**
 * CASHFREE ONLINE PAYMENTS (server-side session flow)
 *
 * Configure keys via Apps Script -> Project Settings -> Script Properties
 * (NEVER hardcode secrets in Code.gs):
 *   CASHFREE_CLIENT_ID      -> your Cashfree Client ID (Dashboard > Settings > API Keys)
 *   CASHFREE_CLIENT_SECRET  -> your Cashfree Secret Key
 *   CASHFREE_ENV            -> "TEST" (sandbox, default) or "PROD" (live)
 *
 * Flow:
 *   1. createPaymentSession: validate the order, reserve it in Google Sheets
 *      with Payment Status "Initiated", create the order on Cashfree via
 *      POST /pg/orders, and return the payment_session_id + return_url.
 *   2. Frontend opens Cashfree's hosted checkout with the session id; after
 *      the attempt it lands on return_url and calls verifyPayment (and the
 *      backend can also be checked directly).
 *   3. verifyPayment: confirm the real status from Cashfree via
 *      GET /pg/orders/{id}; "PAID" -> Success, EXPIRED/CANCELLED/REJECTED ->
 *      Failed, everything else stays Initiated.
 *   4. return_url (action=paymentReturn) -> tiny confirmation page used when
 *      the customer pays on the hosted page without a store return URL.
 */

/**
 * OPTIONAL: Pin the exact spreadsheet to write to.
 * Put the spreadsheet ID (the long string in its URL between /d/ and /edit)
 * here, e.g. "1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890aB".
 *
 * Leave empty string "" to let the script auto-find/create by SPREADSHEET_NAME.
 * Pinning is strongly recommended to avoid writing to the wrong file.
 */
var SPREADSHEET_ID = "1Vjtwwfyem9ufa5GTWwa8RkgGI8t7MVfNBJOZuSWWJY";

// ------------------------------------------------------------
// Web App Entry Points
// ------------------------------------------------------------

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || "").toLowerCase().trim();
  // Cashfree redirects the customer here after a hosted-page payment. Serve a
  // small HTML page instead of the JSON API so it renders in the browser.
  if (action === "paymentreturn") {
    return doPaymentReturn_(e);
  }
  return handleRequest_(e, "GET");
}

function doPost(e) {
  return handleRequest_(e, "POST");
}

function handleRequest_(e, method) {
  var action = (e && e.parameter && e.parameter.action) || "";
  action = String(action).toLowerCase().trim();

  try {
    switch (action) {
      case "signup":
        return doSignup_(e, method);
      case "login":
        return doLogin_(e, method);
      case "googlelogin":
      case "google_auth":
      case "googleauth":
        return doGoogleLogin_(e, method);
      case "order":
        return doOrder_(e, method);
      case "contact":
        return doContact_(e, method);
      case "debug":
        return doDebug_(e, method);
      case "admin_orders":
      case "getorders":
      case "getadminorders":
        return doGetOrders_(e, method);
      case "getorder":
        return doGetOrder_(e, method);
      case "updateorderstatus":
        return doUpdateOrderStatus_(e, method);
      case "updateshipping":
        return doUpdateShipping_(e, method);
      case "updateorder":
        return doUpdateOrder_(e, method);
      case "getdashboardstats":
        return doGetDashboardStats_(e, method);
      case "getcustomers":
        return doGetCustomers_(e, method);
      case "getcontactmessages":
        return doGetContactMessages_(e, method);
      case "trackorder":
        return doTrackOrder_(e, method);
      case "myorders":
        return doMyOrders_(e, method);
      case "createpaymentsession":
      case "cashfreecreate":
      case "createpayment":
        return doCreatePaymentSession_(e, method);
      case "verifypayment":
      case "verifyorderpayment":
        return doVerifyPayment_(e, method);
      case "paymentconfig":
      case "getpaymentconfig":
        return doGetPaymentConfig_(e, method);
      case "updatepaymentstatus":
        return doUpdatePaymentStatus_(e, method);
      case "getproductreviews":
        return doGetProductReviews_(e, method);
      case "getrevieweligibility":
      case "revieweligibility":
        return doGetReviewEligibility_(e, method);
      case "submitreview":
        return doSubmitReview_(e, method);
      case "getreviews":
        return doGetReviews_(e, method);
      case "updatereviewstatus":
      case "moderatereview":
        return doUpdateReviewStatus_(e, method);
      default:
        // Never surface a raw "Unknown action" string to the UI. Return a
        // clean, structured error the frontend can render safely (and log
        // the offending action for debugging).
        try {
          var rawAction = String((e && e.parameter && e.parameter.action) || "").trim();
          if (rawAction) {
            console.log("[LUMINA] Unknown action received: " + rawAction);
          }
        } catch (logErr) {}
        return jsonResponse_({
          success: false,
          error: "INVALID_ACTION",
          message: "Invalid or missing action."
        });
    }
  } catch (err) {
    return jsonResponse_({
      success: false,
      error: "SERVER_ERROR",
      message: "Server error: " + err.toString()
    });
  }
}

// ------------------------------------------------------------
// SIGNUP
// ------------------------------------------------------------

function doSignup_(e, method) {
  var data = getPayload_(e, method);

  var name  = clean_(data.name);
  var email = clean_(data.email).toLowerCase();
  var password = data.password || "";
  var confirmPassword = data.confirmPassword || "";

  // Server-side validation
  if (!name) {
    return jsonResponse_({ success: false, message: "Name cannot be empty." });
  }
  if (!isValidEmail_(email)) {
    return jsonResponse_({ success: false, message: "Please enter a valid email address." });
  }
  if (!password || password.length < 6) {
    return jsonResponse_({ success: false, message: "Password must be at least 6 characters." });
  }
  if (password !== confirmPassword) {
    return jsonResponse_({ success: false, message: "Passwords do not match." });
  }

  var usersSheet = ensureSheet_("Users", USERS_HEADERS);
  migrateUsers_(usersSheet);

  // Duplicate email check
  var emails = usersSheet.getRange(2, 4, Math.max(usersSheet.getLastRow() - 1, 1)).getValues();
  for (var i = 0; i < emails.length; i++) {
    var existing = String(emails[i][0]).toLowerCase().trim();
    if (existing === email) {
      return jsonResponse_({ success: false, message: "Email already registered" });
    }
  }

  // Generate unique user ID
  var userId = "LMN-USER-" + generateId_();

  // Hash the password (SHA-256)
  var passwordHash = hashPassword_(password);

  // Store the user
  usersSheet.appendRow([
    formatTimestamp_(new Date()),
    userId,
    name,
    email,
    passwordHash,
    "Active",
    "customer"
  ]);

  return jsonResponse_({
    success: true,
    message: "Account created successfully",
    user: {
      userId: userId,
      name: name,
      email: email,
      role: "customer"
    }
  });
}

// ------------------------------------------------------------
// LOGIN
// ------------------------------------------------------------

function doLogin_(e, method) {
  var data = getPayload_(e, method);

  var email = clean_(data.email).toLowerCase();
  var password = data.password || "";

  if (!email || !isValidEmail_(email)) {
    return jsonResponse_({ success: false, message: "Invalid email or password" });
  }
  if (!password) {
    return jsonResponse_({ success: false, message: "Invalid email or password" });
  }

  var usersSheet = ensureSheet_("Users", USERS_HEADERS);
  migrateUsers_(usersSheet);

  var lastRow = usersSheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse_({ success: false, message: "Invalid email or password" });
  }

  var values = usersSheet.getRange(2, 1, lastRow - 1, 7).getValues();

  for (var i = 0; i < values.length; i++) {
    var storedEmail = String(values[i][3]).toLowerCase().trim();
    if (storedEmail === email) {
      var storedHash = String(values[i][4]);
      var userId = String(values[i][1]);
      var name = String(values[i][2]);
      var status = String(values[i][5]).toLowerCase();
      var role = values[i][6] ? String(values[i][6]).toLowerCase() : "customer";

      if (status !== "active") {
        return jsonResponse_({ success: false, message: "Account is not active." });
      }

      // Hash the supplied password and compare
      var suppliedHash = hashPassword_(password);
      if (suppliedHash === storedHash) {
        var user = {
          userId: userId,
          name: name,
          email: email,
          role: role
        };

        // For admin, issue a session token (never stored client-side as password).
        if (role === "admin") {
          user.token = createAdminSession_(email);
        }

        return jsonResponse_({
          success: true,
          message: "Login successful",
          user: user
        });
      }

      // Email found but password mismatch
      return jsonResponse_({ success: false, message: "Invalid email or password" });
    }
  }

  // No matching email
  return jsonResponse_({ success: false, message: "Invalid email or password" });
}

function createAdminSession_(email) {
  var token = "lmn" + Utilities.getUuid().replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty("ADMIN_SESSION_" + token, email);
  return token;
}

// Google Identity Services web client id. ID tokens sent by the frontend are
// rejected server-side unless their audience matches this exactly.
var GOOGLE_CLIENT_ID = "337069848561-ubmr9bo18fvkuj34jo4eejfdm9b9lns1.apps.googleusercontent.com";

// ------------------------------------------------------------
// GOOGLE SIGN-IN (frontend sends an ID token; backend verifies it)
// ------------------------------------------------------------

function doGoogleLogin_(e, method) {
  var data = getPayload_(e, method);
  var idToken = clean_(data.idToken);

  if (!idToken) {
    return jsonResponse_({ success: false, message: "Google sign-in failed. Please try again." });
  }

  // The token is verified against Google BEFORE any user data is trusted.
  var payload = verifyGoogleIdToken_(idToken);
  if (!payload) {
    return jsonResponse_({ success: false, message: "Google sign-in could not be verified. Please try again." });
  }

  var email = clean_(payload.email).toLowerCase();
  var name = clean_(payload.name) || email.split("@")[0] || "Google User";
  if (!isValidEmail_(email)) {
    return jsonResponse_({ success: false, message: "Google sign-in could not be verified." });
  }

  var usersSheet = ensureSheet_("Users", USERS_HEADERS);
  migrateUsers_(usersSheet);

  var lastRow = usersSheet.getLastRow();
  var foundUser = null;
  if (lastRow > 1) {
    var values = usersSheet.getRange(2, 1, Math.max(lastRow - 1, 1), 7).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][3]).toLowerCase().trim() === email) {
        foundUser = {
          userId: String(values[i][1]),
          name: String(values[i][2]),
          email: String(values[i][3]).toLowerCase().trim(),
          status: String(values[i][5]).toLowerCase(),
          role: values[i][6] ? String(values[i][6]).toLowerCase() : "customer"
        };
        break;
      }
    }
  }

  var user;
  if (foundUser) {
    if (foundUser.status !== "active") {
      return jsonResponse_({ success: false, message: "Account is not active." });
    }
    user = {
      userId: foundUser.userId,
      name: foundUser.name,
      email: foundUser.email,
      role: foundUser.role
    };
  } else {
    // First Google login for this address: auto-create the account. A random
    // hash is stored so the password flow can never guess it.
    var userId = "LMN-USER-" + generateId_();
    usersSheet.appendRow([
      formatTimestamp_(new Date()),
      userId,
      name,
      email,
      hashPassword_(Utilities.getUuid()),
      "Active",
      "customer"
    ]);
    user = { userId: userId, name: name, email: email, role: "customer" };
  }

  // Same treatment as password login: admins get a session token.
  if (user.role === "admin") {
    user.token = createAdminSession_(user.email);
  }

  return jsonResponse_({
    success: true,
    message: "Login successful",
    user: user
  });
}

/**
 * Server-side verification of a Google ID token.
 *
 * Signature, issuer and expiry are checked by Google's own tokeninfo
 * endpoint. On top of that we enforce:
 *   - audience is exactly GOOGLE_CLIENT_ID (prevents replayed tokens from
 *     other web apps),
 *   - issuer is accounts.google.com,
 *   - the account is email-verified,
 *   - the token has not expired.
 *
 * Returns the verified claim object, or null if untrusted.
 */
function verifyGoogleIdToken_(idToken) {
  try {
    var res = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return null;

    var claims = JSON.parse(res.getContentText());
    if (!claims || typeof claims !== "object") return null;

    if (String(claims.aud) !== GOOGLE_CLIENT_ID) return null;

    var issuer = String(claims.iss || "");
    if (issuer !== "accounts.google.com" && issuer !== "https://accounts.google.com") return null;

    if (String(claims.email_verified) !== "true") return null;

    var exp = Number(claims.exp);
    if (!exp || exp <= Math.floor(Date.now() / 1000)) return null;

    if (!claims.email || !claims.sub) return null;

    return claims;
  } catch (err) {
    return null;
  }
}

// ------------------------------------------------------------
// ADMIN AUTH HELPERS
// ------------------------------------------------------------

/**
 * Validates the admin session token + confirms the account is still an
 * active admin in the Users sheet.
 * Returns { ok:true, adminEmail } or { ok:false, res: <jsonResponse_> }.
 */
function requireAdmin_(e, method) {
  var data = getPayload_(e, method);
  var token = clean_(data.token);
  if (!token) {
    return { ok: false, res: jsonResponse_({ success: false, message: "Admin login required." }) };
  }

  var props = PropertiesService.getScriptProperties();
  var adminEmail = props.getProperty("ADMIN_SESSION_" + token);
  if (!adminEmail) {
    return { ok: false, res: jsonResponse_({ success: false, message: "Invalid or expired admin session. Please log in again." }) };
  }

  // Confirm the account is still an active admin
  var usersSheet = ensureSheet_("Users", USERS_HEADERS);
  migrateUsers_(usersSheet);
  var lastRow = usersSheet.getLastRow();
  var isAdmin = false;
  if (lastRow > 1) {
    var uv = usersSheet.getRange(2, 3, lastRow - 1, 5).getValues(); // Name, Email, Hash, Status, Role
    for (var i = 0; i < uv.length; i++) {
      if (String(uv[i][1]).toLowerCase().trim() === String(adminEmail).toLowerCase().trim()) {
        if (String(uv[i][3]).toLowerCase() === "active" && String(uv[i][4]).toLowerCase() === "admin") {
          isAdmin = true;
        }
        break;
      }
    }
  }
  if (!isAdmin) {
    return { ok: false, res: jsonResponse_({ success: false, message: "You do not have admin access." }) };
  }

  return { ok: true, res: null, adminEmail: adminEmail };
}

// ------------------------------------------------------------
// ORDERS READ
// ------------------------------------------------------------

/**
 * Reads every order from the Orders tab into clean objects.
 * The tab is line-item based (one row per product line), so rows sharing the
 * same Order ID are grouped back into a single order with a products array.
 * Newest first. Legacy "Placed" status is normalized to "Pending".
 */
function readAllOrders_() {
  var ordersSheet = ensureSheet_("Orders", ORDERS_HEADERS);

  // Locate each column by its header name instead of assuming a fixed layout.
  // This keeps the reader correct even if the Orders tab's columns were
  // reordered or written by an earlier schema.
  var map = getColumnMap_(ordersSheet, [
    "Order ID", "Customer Name", "Phone", "Address", "Product",
    "Qty", "Amount", "Payment Status", "Order Status", "AWB", "Courier", "Created At",
    "Email", "User ID", "Product ID", "Payment Method", "Email Sent"
  ]);
  if (map["Order ID"] === undefined) return []; // cannot resolve orders without the Order ID column

  var orders = [];
  var oLast = ordersSheet.getLastRow();
  if (oLast > 1) {
    var width = Math.max(ordersSheet.getLastColumn(), 1);
    var ovals = ordersSheet.getRange(2, 1, oLast - 1, width).getValues();
    var index = {}; // normalized orderId -> order object
    for (var j = 0; j < ovals.length; j++) {
      var orderId = normalizeOrderId_(val_(ovals[j], map["Order ID"]));
      if (!orderId) continue; // skip stray/blank rows

      var o = index[orderId];
      if (!o) {
        var legacyPay = String(val_(ovals[j], map["Payment Status"]));
        var method = String(val_(ovals[j], map["Payment Method"]));
        o = {
          timestamp: String(val_(ovals[j], map["Created At"])),
          orderId: orderId,
          userId: String(val_(ovals[j], map["User ID"])),
          name: String(val_(ovals[j], map["Customer Name"])),
          email: String(val_(ovals[j], map["Email"])),
          emailSent: String(val_(ovals[j], map["Email Sent"])),
          phone: String(val_(ovals[j], map["Phone"])),
          address: String(val_(ovals[j], map["Address"])),
          city: "",
          pincode: "",
          products: [],
          total: 0,
          paymentMethod: method !== "" ? method : legacyPay, // real method with legacy fallback
          paymentStatus: legacyPay, // Payment Status column
          status: normalizeStatus_(String(val_(ovals[j], map["Order Status"]))), // Order Status column
          awb: String(val_(ovals[j], map["AWB"])),
          courier: String(val_(ovals[j], map["Courier"])),
          lastUpdated: ""
        };
        orders.push(o);
        index[orderId] = o;
      }

      var qty = Number(val_(ovals[j], map["Qty"])) || 0;
      var amount = Number(val_(ovals[j], map["Amount"])) || 0;
      o.products.push({
        productId: String(val_(ovals[j], map["Product ID"])),
        name: String(val_(ovals[j], map["Product"])),
        qty: qty,
        price: qty > 0 ? Math.round((amount / qty) * 100) / 100 : amount
      });
      o.total += amount;
    }
  }
  orders.reverse(); // newest first
  return orders;
}

function val_(row, col) {
  if (col === undefined || col === null || col < 0 || col >= row.length) return "";
  return row[col];
}

// Builds a { Header Name: zero-based column index } map from the sheet's first row.
function getColumnMap_(sheet, names) {
  var width = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var head = String(headers[i]).trim().toLowerCase();
    if (!head) continue;
    for (var n = 0; n < names.length; n++) {
      if (map[names[n]] === undefined && String(names[n]).toLowerCase() === head) {
        map[names[n]] = i;
      }
    }
  }
  return map;
}

// Order IDs are UUID-derived and case-insensitive; normalize so whitespace or
// case differences never cause a valid order to be reported as "not found".
function normalizeOrderId_(v) {
  return String(v === undefined || v === null ? "" : v).trim().toUpperCase();
}

function normalizeStatus_(st) {
  var s = String(st).trim();
  return s === "Placed" ? "Pending" : s;
}

// ------------------------------------------------------------
// ADMIN — LIST ORDERS  (alias: admin_orders)
// ------------------------------------------------------------

function doGetOrders_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var orders = readAllOrders_();
  return jsonResponse_({
    success: true,
    message: "Orders loaded",
    orders: orders
  });
}

// ------------------------------------------------------------
// ADMIN — SINGLE ORDER
// ------------------------------------------------------------

function doGetOrder_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var data = getPayload_(e, method);
  var orderId = normalizeOrderId_(data.orderId);
  if (!orderId) {
    return jsonResponse_({ success: false, error: "INVALID_INPUT", message: "Order ID is required." });
  }

  var orders = readAllOrders_();
  for (var i = 0; i < orders.length; i++) {
    if (orders[i].orderId === orderId) {
      return jsonResponse_({ success: true, message: "Order found", order: orders[i] });
    }
  }
  return jsonResponse_({ success: false, error: "ORDER_NOT_FOUND", message: "Order not found" });
}

// ------------------------------------------------------------
// ADMIN — UPDATE ORDER STATUS  (persists to Google Sheets)
// ------------------------------------------------------------

function doUpdateOrderStatus_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var data = getPayload_(e, method);
  var orderId = normalizeOrderId_(data.orderId);
  var newStatus = clean_(data.status);

  if (!orderId) {
    return jsonResponse_({ success: false, message: "Order ID is required." });
  }
  if (VALID_ORDER_STATUSES.indexOf(newStatus) === -1) {
    return jsonResponse_({ success: false, message: "Invalid order status" });
  }

  var ordersSheet = ensureSheet_("Orders", ORDERS_HEADERS);
  var width = Math.max(ordersSheet.getLastColumn(), 1);
  var headers = ordersSheet.getRange(1, 1, 1, width).getValues()[0];
  var idCol = -1, statusCol = -1, luCol = -1;
  for (var h = 0; h < headers.length; h++) {
    if (String(headers[h]).trim() === "Order ID") idCol = h;
    else if (String(headers[h]).trim() === "Order Status" || String(headers[h]).trim() === "Status") statusCol = h;
    else if (String(headers[h]).trim() === "Last Updated") luCol = h;
  }
  if (idCol === -1 || statusCol === -1) {
    return jsonResponse_({ success: false, message: "Orders sheet is missing required columns." });
  }

  var lastRow = ordersSheet.getLastRow();
  var found = false;
  if (lastRow > 1) {
    var dataRows = ordersSheet.getRange(2, 1, lastRow - 1, width).getValues();
    var luStamp = formatTimestamp_(new Date());
    for (var i = 0; i < dataRows.length; i++) {
      if (String(dataRows[i][idCol]).trim().toUpperCase() === orderId) {
        found = true;
        var rowNum = i + 2;
        ordersSheet.getRange(rowNum, statusCol + 1).setValue(newStatus);
        if (luCol !== -1) {
          ordersSheet.getRange(rowNum, luCol + 1).setValue(luStamp);
        }
      }
    }
  }

  if (found) {
    return jsonResponse_({
      success: true,
      message: "Order status updated successfully",
      orderId: orderId,
      status: newStatus
    });
  }

  return jsonResponse_({ success: false, message: "Order not found" });
}

// ------------------------------------------------------------
// ADMIN — UPDATE SHIPPING (AWB + Courier)  (persists to Google Sheets)
// ------------------------------------------------------------

function doUpdateShipping_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var data = getPayload_(e, method);
  var orderId = normalizeOrderId_(data.orderId);
  var courier = clean_(data.courier);
  var awb = clean_(data.awb);

  if (!orderId) {
    return jsonResponse_({ success: false, message: "Order ID is required." });
  }
  if (!courier && !awb) {
    return jsonResponse_({ success: false, message: "Enter a courier and/or an AWB number." });
  }

  var ordersSheet = ensureSheet_("Orders", ORDERS_HEADERS);
  var width = Math.max(ordersSheet.getLastColumn(), 1);
  var headers = ordersSheet.getRange(1, 1, 1, width).getValues()[0];
  var idCol = -1, awbCol = -1, courierCol = -1;
  for (var h = 0; h < headers.length; h++) {
    var head = String(headers[h]).trim();
    if (head === "Order ID") idCol = h;
    else if (head === "AWB") awbCol = h;
    else if (head === "Courier") courierCol = h;
  }
  if (idCol === -1 || awbCol === -1 || courierCol === -1) {
    return jsonResponse_({ success: false, message: "Orders sheet is missing required columns (Order ID, AWB, Courier)." });
  }

  var lastRow = ordersSheet.getLastRow();
  var found = false;
  if (lastRow > 1) {
    var dataRows = ordersSheet.getRange(2, 1, lastRow - 1, width).getValues();
    for (var i = 0; i < dataRows.length; i++) {
      if (String(dataRows[i][idCol]).trim().toUpperCase() === orderId) {
        found = true;
        var rowNum = i + 2;
        ordersSheet.getRange(rowNum, awbCol + 1).setValue(awb);
        ordersSheet.getRange(rowNum, courierCol + 1).setValue(courier);
      }
    }
  }

  if (found) {
    return jsonResponse_({
      success: true,
      message: "Shipping details saved successfully",
      orderId: orderId,
      courier: courier,
      awb: awb
    });
  }
  return jsonResponse_({ success: false, message: "Order not found" });
}

// ------------------------------------------------------------
// ADMIN — UPDATE ORDER (Status + Courier + AWB in ONE call)
// Accepts: orderId + any of status / courierName (or courier) /
// awbNumber (or awb). Only the provided fields are written so all
// existing order data is preserved. Rows are found using the real
// Order ID in the sheet — never a frontend row index.
// ------------------------------------------------------------

function doUpdateOrder_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var data = getPayload_(e, method);
  var orderId = normalizeOrderId_(data.orderId);
  var newStatus = clean_(data.status);
  var courier = clean_(data.courierName || data.courier);
  var awb = clean_(data.awbNumber || data.awb);
  var paymentStatus = clean_(data.paymentStatus);

  if (!orderId) {
    return jsonResponse_({ success: false, message: "Order ID is required." });
  }
  if (!newStatus && !courier && !awb && !paymentStatus) {
    return jsonResponse_({ success: false, message: "Provide at least one field to update (status, courier, AWB or payment status)." });
  }
  if (newStatus && VALID_ORDER_STATUSES.indexOf(newStatus) === -1) {
    return jsonResponse_({ success: false, message: "Invalid order status." });
  }
  if (paymentStatus && VALID_PAYMENT_STATUSES.indexOf(paymentStatus) === -1) {
    return jsonResponse_({ success: false, message: "Invalid payment status." });
  }

  var ordersSheet = ensureSheet_("Orders", ORDERS_HEADERS);
  var width = Math.max(ordersSheet.getLastColumn(), 1);
  var headers = ordersSheet.getRange(1, 1, 1, width).getValues()[0];
  var idCol = -1, statusCol = -1, luCol = -1, courierCol = -1, awbCol = -1, payCol = -1;
  for (var h = 0; h < headers.length; h++) {
    var head = String(headers[h]).trim();
    if (head === "Order ID") idCol = h;
    else if (head === "Order Status" || head === "Status") statusCol = h;
    else if (head === "Last Updated") luCol = h;
    else if (head === "Courier" || head === "Courier Name") courierCol = h;
    else if (head === "AWB" || head === "AWB Number" || head === "AWB Tracking Number") awbCol = h;
    else if (head === "Payment Status") payCol = h;
  }
  if (idCol === -1
      || (newStatus && statusCol === -1)
      || (courier && courierCol === -1)
      || (awb && awbCol === -1)
      || (paymentStatus && payCol === -1)) {
    return jsonResponse_({ success: false, message: "Orders sheet is missing required columns (Order ID, plus any field you are updating)." });
  }

  var lastRow = ordersSheet.getLastRow();
  var found = false;
  var luStamp = formatTimestamp_(new Date());
  if (lastRow > 1) {
    var dataRows = ordersSheet.getRange(2, 1, lastRow - 1, width).getValues();
    for (var i = 0; i < dataRows.length; i++) {
      if (String(dataRows[i][idCol]).trim().toUpperCase() === orderId) {
        found = true;
        var rowNum = i + 2;
        if (newStatus) {
          ordersSheet.getRange(rowNum, statusCol + 1).setValue(newStatus);
          if (luCol !== -1) {
            ordersSheet.getRange(rowNum, luCol + 1).setValue(luStamp);
          }
        }
        if (paymentStatus) {
          ordersSheet.getRange(rowNum, payCol + 1).setValue(paymentStatus);
        }
        if (courier) {
          ordersSheet.getRange(rowNum, courierCol + 1).setValue(courier);
        }
        if (awb) {
          ordersSheet.getRange(rowNum, awbCol + 1).setValue(awb);
        }
      }
    }
  }

  if (!found) {
    return jsonResponse_({ success: false, message: "Order not found" });
  }

  if (paymentStatus === "Success") {
    maybeSendOrderEmail_(orderId);
  }

  var updated = { orderId: orderId };
  if (newStatus) updated.status = newStatus;
  if (paymentStatus) updated.paymentStatus = paymentStatus;
  if (courier) updated.courier = courier;
  if (awb) updated.awb = awb;
  return jsonResponse_({
    success: true,
    message: "Order updated successfully",
    updated: updated
  });
}

// ------------------------------------------------------------
// ADMIN — DASHBOARD STATS  (computed from sheet data)
// ------------------------------------------------------------

function doGetDashboardStats_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var orders = readAllOrders_();
  var counts = {
    "Pending": 0,
    "Processing": 0,
    "Shipped": 0,
    "Out for Delivery": 0,
    "Delivered": 0,
    "Cancelled": 0
  };
  var totalRevenue = 0;
  for (var i = 0; i < orders.length; i++) {
    var st = orders[i].status;
    if (counts.hasOwnProperty(st)) counts[st] += 1;
    totalRevenue += Number(orders[i].total) || 0;
  }

  return jsonResponse_({
    success: true,
    stats: {
      totalOrders: orders.length,
      totalRevenue: totalRevenue,
      counts: counts
    }
  });
}

// ------------------------------------------------------------
// ADMIN — CUSTOMERS  (Users sheet + order aggregation)
// ------------------------------------------------------------

function doGetCustomers_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var usersSheet = ensureSheet_("Users", USERS_HEADERS);
  migrateUsers_(usersSheet);

  var map = {};
  var lastRow = usersSheet.getLastRow();
  if (lastRow > 1) {
    var uv = usersSheet.getRange(2, 1, lastRow - 1, 7).getValues();
    for (var i = 0; i < uv.length; i++) {
      var em = String(uv[i][3]).toLowerCase().trim();
      if (!em) continue;
      map[em] = {
        email: em,
        name: String(uv[i][2]),
        userId: String(uv[i][1]),
        joined: String(uv[i][0]),
        phone: "",
        totalOrders: 0,
        totalSpent: 0,
        latestOrder: "",
        latestStatus: ""
      };
    }
  }

  var orders = readAllOrders_();
  for (var j = 0; j < orders.length; j++) {
    var oe = String(orders[j].email).toLowerCase().trim();
    if (!oe) continue;
    var c = map[oe];
    if (!c) {
      c = map[oe] = {
        email: oe,
        name: String(orders[j].name || ""),
        userId: String(orders[j].userId || ""),
        joined: "",
        phone: String(orders[j].phone || ""),
        totalOrders: 0,
        totalSpent: 0,
        latestOrder: "",
        latestStatus: ""
      };
    }
    c.totalOrders += 1;
    c.totalSpent += Number(orders[j].total) || 0;
    if (!c.phone && orders[j].phone) c.phone = String(orders[j].phone);
    if (!c.latestOrder) {
      c.latestOrder = orders[j].orderId;
      c.latestStatus = orders[j].status;
      c.latestDate = orders[j].timestamp;
    }
  }

  var customers = [];
  for (var key in map) {
    if (map.hasOwnProperty(key)) customers.push(map[key]);
  }
  customers.sort(function (a, b) { return b.totalSpent - a.totalSpent; });

  return jsonResponse_({ success: true, customers: customers });
}

// ------------------------------------------------------------
// ADMIN — CONTACT MESSAGES
// ------------------------------------------------------------

function doGetContactMessages_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var sheet = ensureSheet_("Contact Messages", CONTACT_HEADERS);
  var messages = [];
  var last = sheet.getLastRow();
  if (last > 1) {
    var vals = sheet.getRange(2, 1, last - 1, CONTACT_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      messages.push({
        timestamp: String(vals[i][0]),
        name: String(vals[i][1]),
        email: String(vals[i][2]),
        subject: String(vals[i][3]),
        message: String(vals[i][4]),
        status: String(vals[i][5])
      });
    }
  }
  messages.reverse(); // newest first

  return jsonResponse_({ success: true, messages: messages });
}

// ------------------------------------------------------------
// CUSTOMER — TRACK ORDER (public, by Order ID + email/phone)
// ------------------------------------------------------------

function doTrackOrder_(e, method) {
  var data = getPayload_(e, method);
  var orderId = normalizeOrderId_(data.orderId);

  if (!orderId) {
    return jsonResponse_({ success: false, error: "INVALID_INPUT", message: "Please enter your Order ID." });
  }

  try {
    // Lookup by Order ID only. Only the matching order is returned; the rest of
    // the sheet is never exposed to the customer.
    var orders = readAllOrders_();
    for (var i = 0; i < orders.length; i++) {
      if (orders[i].orderId === orderId) {
        var o = orders[i];

        // Add the contract alias fields (customerName / product / qty / amount /
        // paymentStatus / orderStatus / createdAt) alongside the existing rich
        // schema so the frontend's existing order card keeps working unchanged.
        var prodNames = [];
        var totalQty = 0;
        for (var qi = 0; qi < (o.products || []).length; qi++) {
          prodNames.push(String(o.products[qi].name || "").trim());
          totalQty += Number(o.products[qi].qty) || 0;
        }
        o.customerName = o.name;
        o.product = prodNames.filter(function (s) { return s !== ""; }).join(", ");
        o.qty = totalQty;
        o.amount = o.total;
        o.paymentStatus = o.paymentStatus || o.paymentMethod;
        o.orderStatus = o.status;
        o.createdAt = o.timestamp;

        return jsonResponse_({
          success: true,
          action: "trackOrder",
          message: "Order found",
          order: o
        });
      }
    }
    return jsonResponse_({ success: false, error: "ORDER_NOT_FOUND", message: "Order not found" });
  } catch (err) {
    return jsonResponse_({ success: false, error: "SERVER_ERROR", message: "Unable to retrieve order" });
  }
}

// ------------------------------------------------------------
// CUSTOMER — MY ORDERS (logged-in user's own orders)
// ------------------------------------------------------------

function doMyOrders_(e, method) {
  var data = getPayload_(e, method);
  var email = clean_(data.email).toLowerCase();
  var userId = clean_(data.userId);

  if (!email && !userId) {
    return jsonResponse_({ success: false, message: "Please log in to view your orders." });
  }

  var orders = readAllOrders_();
  var mine = [];
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    var emailMatch = email && String(o.email).toLowerCase() === email;
    var userMatch = userId && o.userId && String(o.userId) === userId;
    if (emailMatch || userMatch) {
      mine.push(o);
    }
  }

  return jsonResponse_({ success: true, orders: mine });
}

// ------------------------------------------------------------
// ORDER
// ------------------------------------------------------------

function doOrder_(e, method) {
  var data = getPayload_(e, method);

  var userId    = clean_(data.userId);
  var name      = clean_(data.name);
  var email     = clean_(data.email).toLowerCase();
  var phone     = clean_(data.phone);
  var address   = clean_(data.address);
  var city      = clean_(data.city);
  var pincode   = clean_(data.pincode);
  var products  = data.products;      // JSON array string or array
  var total     = data.total;
  var paymentMethod = clean_(data.paymentMethod) || "Cash on Delivery";

  // Validation
  if (!userId) return jsonResponse_({ success: false, message: "User is not authenticated." });
  if (!name)  return jsonResponse_({ success: false, message: "Full name is required." });
  if (!email || !isValidEmail_(email)) return jsonResponse_({ success: false, message: "A valid email is required." });
  if (!phone || !isValidPhone_(phone)) return jsonResponse_({ success: false, message: "A valid phone number is required." });
  if (!address) return jsonResponse_({ success: false, message: "Address is required." });
  if (!city)  return jsonResponse_({ success: false, message: "City is required." });
  if (!pincode || !isValidPincode_(pincode)) return jsonResponse_({ success: false, message: "A valid pincode is required." });
  // Products arrive as a JSON array (POST body). Accept a JSON string too.
  if (typeof products === "string") {
    try { products = JSON.parse(products) || []; } catch (err) { products = []; }
  }
  if (!Array.isArray(products) || products.length === 0) {
    return jsonResponse_({ success: false, message: "Your cart is empty." });
  }

  var totalNum = Number(total);
  if (isNaN(totalNum)) totalNum = 0;

  var orderId = "LMN-ORD-" + generateId_();

  var now = new Date();
  var created = formatTimestamp_(now);
  var ordersSheet = ensureSheet_("Orders", ORDERS_HEADERS);

  // The Orders tab is line-item based: one row per product line.
  // All lines of the same order share the same Order ID and Created At.
  //
  // Defaults for a new order:
  //   Order Status = "Pending"
  //   AWB          = ""   (filled later by AWB tracking step)
  //   Courier      = ""   (filled later by courier integration step)
  //   Created At   = now
  //   Payment Status uses the existing flow (Cash on Delivery only — there is
  //   no payment-confirmation mechanism, so it honestly stays "Pending").
  var paymentStatus = "Pending";

  for (var i = 0; i < products.length; i++) {
    var line = products[i] || {};
    var qty = Number(line.qty) || 0;
    var price = Number(line.price) || 0;
    if (qty <= 0) continue; // skip empty lines

    ordersSheet.appendRow([
      orderId,
      name,
      phone,
      address,
      String(line.name || ""),
      qty,
      Math.round(qty * price * 100) / 100,
      paymentStatus,
      "Pending", // Order Status
      "",        // AWB
      "",        // Courier
      created,   // Created At
      email,     // Email
      userId,    // User ID
      String(line.id || ""), // Product ID
      paymentMethod,          // Payment Method
      ""         // Email Sent
    ]);
  }

  // Send the order confirmation email (idempotent; failures never break the order).
  maybeSendOrderEmail_(orderId);

  return jsonResponse_({
    success: true,
    message: "Order placed successfully",
    order: {
      orderId: orderId,
      name: name,
      total: totalNum
    }
  });
}

// ------------------------------------------------------------
// CASHFREE — ONLINE PAYMENTS (server-side session flow)
// ------------------------------------------------------------

function getCashfreeConfig_() {
  var props = PropertiesService.getScriptProperties();
  var env = String(props.getProperty("CASHFREE_ENV") || "").trim().toUpperCase();
  if (env !== "TEST" && env !== "PROD") env = "TEST";
  return {
    env: env,
    mode: env === "TEST" ? "sandbox" : "production",
    clientId: String(props.getProperty("CASHFREE_CLIENT_ID") || "").trim(),
    clientSecret: String(props.getProperty("CASHFREE_CLIENT_SECRET") || "").trim(),
    baseUrl: env === "TEST" ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg"
  };
}

function isCashfreeConfigured_(cfg) {
  cfg = cfg || getCashfreeConfig_();
  return cfg.clientId !== "" && cfg.clientSecret !== "";
}

// Low-level Cashfree PG API call (v2022-09-01). Always mutes HTTP exceptions
// so callers can branch on { status, json } themselves.
function cashfreeApi_(path, method, body, cfg) {
  cfg = cfg || getCashfreeConfig_();
  var options = {
    method: method || "GET",
    headers: {
      "x-api-version": "2022-09-01",
      "x-client-id": cfg.clientId,
      "x-client-secret": cfg.clientSecret,
      "Content-Type": "application/json"
    },
    muteHttpExceptions: true,
    redirect: "follow"
  };
  if (body !== undefined && body !== null) options.payload = JSON.stringify(body);
  var resp = UrlFetchApp.fetch(cfg.baseUrl + path, options);
  var json = {};
  try { json = JSON.parse(resp.getContentText()); } catch (err) {}
  return { status: resp.getResponseCode(), json: json };
}

// Writes a new Payment Status to every row of an order. Returns false if the
// Orders sheet has no Payment Status column (should never happen in practice).
function setPaymentStatus_(orderId, newStatus, sheet) {
  sheet = sheet || ensureSheet_("Orders", ORDERS_HEADERS);
  var width = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  var idCol = -1, payCol = -1;
  for (var h = 0; h < headers.length; h++) {
    var head = String(headers[h]).trim();
    if (head === "Order ID") idCol = h;
    else if (head === "Payment Status") payCol = h;
  }
  if (idCol === -1 || payCol === -1) return false;
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][idCol]).trim().toUpperCase() === orderId) {
        sheet.getRange(i + 2, payCol + 1).setValue(newStatus);
      }
    }
  }
  return true;
}

// PUBLIC — tells the checkout whether "Pay Online" is available (sandbox mode).
function doGetPaymentConfig_(e, method) {
  var cfg = getCashfreeConfig_();
  return jsonResponse_({
    success: true,
    onlineEnabled: isCashfreeConfigured_(cfg),
    mode: cfg.mode,
    env: cfg.env
  });
}

// PUBLIC — create a Cashfree payment session for the order:
//   1. validate the same fields as a normal order,
//   2. reserve the order in Sheets with Payment Status "Initiated",
//   3. create the order on Cashfree (POST /pg/orders),
//   4. hand back payment_session_id + return_url to the frontend.
function doCreatePaymentSession_(e, method) {
  var data = getPayload_(e, method);

  var userId    = clean_(data.userId);
  var name      = clean_(data.name);
  var email     = clean_(data.email).toLowerCase();
  var phone     = clean_(data.phone);
  var address   = clean_(data.address);
  var city      = clean_(data.city);
  var pincode   = clean_(data.pincode);
  var products  = data.products;      // JSON array string or array
  var total     = data.total;
  var frontend  = clean_(data.returnUrl);

  if (!userId) return jsonResponse_({ success: false, message: "User is not authenticated." });
  if (!name)  return jsonResponse_({ success: false, message: "Full name is required." });
  if (!email || !isValidEmail_(email)) return jsonResponse_({ success: false, message: "A valid email is required." });
  if (!phone || !isValidPhone_(phone)) return jsonResponse_({ success: false, message: "A valid phone number is required." });
  if (!address) return jsonResponse_({ success: false, message: "Address is required." });
  if (!city)  return jsonResponse_({ success: false, message: "City is required." });
  if (!pincode || !isValidPincode_(pincode)) return jsonResponse_({ success: false, message: "A valid pincode is required." });
  if (typeof products === "string") {
    try { products = JSON.parse(products) || []; } catch (err) { products = []; }
  }
  if (!Array.isArray(products) || products.length === 0) {
    return jsonResponse_({ success: false, message: "Your cart is empty." });
  }

  var cfg = getCashfreeConfig_();
  if (!isCashfreeConfigured_(cfg)) {
    return jsonResponse_({
      success: false,
      error: "CASHFREE_NOT_CONFIGURED",
      message: "Online payments are not enabled yet. Please use Cash on Delivery, or add your Cashfree keys in Script Properties."
    });
  }

  var totalNum = Number(total);
  if (isNaN(totalNum)) totalNum = 0;
  if (!(totalNum > 0)) {
    return jsonResponse_({ success: false, message: "A valid order total is required for online payment." });
  }

  var orderId = "LMN-ORD-" + generateId_();
  var now = new Date();
  var created = formatTimestamp_(now);
  var ordersSheet = ensureSheet_("Orders", ORDERS_HEADERS);

  // Reserve the order as "Initiated". The final mark (Success/Failed) is
  // written by verifyPayment once Cashfree confirms the real status.
  for (var i = 0; i < products.length; i++) {
    var line = products[i] || {};
    var qty = Number(line.qty) || 0;
    var price = Number(line.price) || 0;
    if (qty <= 0) continue;
    ordersSheet.appendRow([
      orderId,
      name,
      phone,
      address,
      String(line.name || ""),
      qty,
      Math.round(qty * price * 100) / 100,
      "Initiated", // Payment Status
      "Pending",   // Order Status
      "",          // AWB
      "",          // Courier
      created,     // Created At
      email,       // Email
      userId,      // User ID
      String(line.id || ""), // Product ID
      "Pay Online",          // Payment Method
      ""           // Email Sent
    ]);
  }

  // Where the customer lands after paying. Prefer the store's own page (the
  // frontend passes origin + path) so they return straight to the store with
  // ?payment_return=<orderId>; fall back to this app's confirmation page.
  var appUrl = ScriptApp.getService().getUrl();
  var returnUrl = appUrl + "?action=paymentReturn&order_id=" + encodeURIComponent(orderId);
  if (frontend) {
    var sep = frontend.indexOf("?") === -1 ? "?" : "&";
    returnUrl = frontend + sep + "payment_return=" + encodeURIComponent(orderId);
  }

  var customerId = String(userId || ("lumina-" + orderId)).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 50);

  try {
    var cfResp = cashfreeApi_("/orders", "POST", {
      order_id: orderId,
      order_amount: Math.round(totalNum * 100) / 100,
      order_currency: "INR",
      order_note: "Lumina Skincare order",
      customer_details: {
        customer_id: customerId,
        customer_name: name,
        customer_email: email,
        customer_phone: phone
      },
      order_meta: { return_url: returnUrl }
    }, cfg);

    if (!cfResp || cfResp.status < 200 || cfResp.status >= 300 || !cfResp.json || !cfResp.json.payment_session_id) {
      setPaymentStatus_(orderId, "Failed", ordersSheet);
      console.log("[LUMINA][cashfree] createOrder failed status=" + (cfResp && cfResp.status) + " body=" + JSON.stringify(cfResp && cfResp.json));
      return jsonResponse_({
        success: false,
        error: "CASHFREE_ERROR",
        message: "We couldn't start the payment right now. Please try again or choose Cash on Delivery.",
        detail: String(((cfResp && cfResp.json && cfResp.json.message) || "")).slice(0, 200)
      });
    }

    return jsonResponse_({
      success: true,
      message: "Payment session created",
      orderId: orderId,
      paymentSessionId: cfResp.json.payment_session_id,
      paymentLink: cfResp.json.payment_link || "",
      returnUrl: returnUrl,
      mode: cfg.mode,
      env: cfg.env
    });
  } catch (err) {
    setPaymentStatus_(orderId, "Failed", ordersSheet);
    console.log("[LUMINA][cashfree] createOrder threw: " + err);
    return jsonResponse_({
      success: false,
      error: "CASHFREE_ERROR",
      message: "Payment setup failed. Please try again or choose Cash on Delivery."
    });
  }
}

// PUBLIC — ask Cashfree for the real order status and persist it.
//   "PAID"                      -> Success
//   "EXPIRED"/"CANCELLED"/"REJECTED" -> Failed (never downgrade a confirmed success)
//   anything else (ACTIVE, ...) -> stays Initiated
function doVerifyPayment_(e, method) {
  var data = getPayload_(e, method);
  var orderId = normalizeOrderId_(data.orderId);
  if (!orderId) {
    return jsonResponse_({ success: false, message: "Order ID is required." });
  }

  var orders = readAllOrders_();
  var order = null;
  for (var i = 0; i < orders.length; i++) {
    if (orders[i].orderId === orderId) { order = orders[i]; break; }
  }
  if (!order) {
    return jsonResponse_({ success: false, error: "ORDER_NOT_FOUND", message: "Order not found" });
  }

  var cfg = getCashfreeConfig_();
  var sheetStatus = String(order.paymentStatus || order.paymentMethod || "");

  // Cashfree disabled: report what the sheet already knows rather than failing.
  if (!isCashfreeConfigured_(cfg)) {
    return jsonResponse_({
      success: true,
      paymentStatus: sheetStatus === "Success" ? "Success" : "Initiated",
      message: sheetStatus === "Success" ? "Payment confirmed." : "Payment status is pending."
    });
  }

  try {
    var cfResp = cashfreeApi_("/orders/" + encodeURIComponent(orderId), "GET", undefined, cfg);
    if (!cfResp || cfResp.status < 200 || cfResp.status >= 300 || !cfResp.json) {
      if (sheetStatus === "Success") {
        return jsonResponse_({ success: true, paymentStatus: "Success", message: "Payment confirmed." });
      }
      return jsonResponse_({ success: true, paymentStatus: "Initiated", message: "Your payment is still being confirmed." });
    }

    var st = String(cfResp.json.order_status || "").toUpperCase();
    if (st === "PAID") {
      setPaymentStatus_(orderId, "Success");
      maybeSendOrderEmail_(orderId);
      return jsonResponse_({ success: true, paymentStatus: "Success", message: "Payment confirmed. Thank you!" });
    }
    if (st === "EXPIRED" || st === "CANCELLED" || st === "REJECTED") {
      if (sheetStatus === "Success") {
        return jsonResponse_({ success: true, paymentStatus: "Success", message: "Payment confirmed." });
      }
      setPaymentStatus_(orderId, "Failed");
      return jsonResponse_({ success: true, paymentStatus: "Failed", message: "The payment was not completed." });
    }
    return jsonResponse_({ success: true, paymentStatus: "Initiated", message: "Your payment is still being processed. We will confirm it shortly." });
  } catch (err) {
    return jsonResponse_({ success: false, error: "SERVER_ERROR", message: "Unable to verify the payment right now. Please try again." });
  }
}

// ADMIN — manually change an order's Payment Status (correct a missed
// confirmation, update Cash on Delivery as collected, etc.).
function doUpdatePaymentStatus_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var data = getPayload_(e, method);
  var orderId = normalizeOrderId_(data.orderId);
  var newStatus = clean_(data.paymentStatus || data.status);

  if (!orderId) return jsonResponse_({ success: false, message: "Order ID is required." });
  if (VALID_PAYMENT_STATUSES.indexOf(newStatus) === -1) {
    return jsonResponse_({ success: false, message: "Invalid payment status." });
  }

  if (!setPaymentStatus_(orderId, newStatus)) {
    return jsonResponse_({ success: false, message: "Orders sheet is missing the Payment Status column." });
  }
  if (newStatus === "Success") {
    maybeSendOrderEmail_(orderId);
  }
  return jsonResponse_({
    success: true,
    message: "Payment status updated successfully",
    orderId: orderId,
    paymentStatus: newStatus
  });
}

// ------------------------------------------------------------
// ORDER CONFIRMATION EMAIL (MailApp, server-side, idempotent)
// ------------------------------------------------------------

/**
 * Sends the "order confirmed" email for an order exactly once. A checkmark is
 * written to the "Email Sent" column after a successful send so a later
 * trigger (verify payment, admin status change) never duplicates it. Any
 * failure is swallowed — email problems must never break an order.
 * Returns true when the email was sent, false otherwise.
 */
function maybeSendOrderEmail_(orderId) {
  if (!orderId) return false;
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) {}
  try {
    var orders = readAllOrders_();
    var order = null;
    for (var i = 0; i < orders.length; i++) {
      if (orders[i].orderId === orderId) { order = orders[i]; break; }
    }
    if (!order) return false;
    if (String(order.emailSent || "") !== "") return false; // already sent
    var email = String(order.email || "").toLowerCase().trim();
    if (!isValidEmail_(email)) return false;

    var items = (order.products || []).map(function (p) {
      return "<tr><td style=\"padding:10px 12px;border-bottom:1px solid #eee;\">" + escapeHtml_(String(p.name || ""))
        + "</td><td style=\"padding:10px 12px;border-bottom:1px solid #eee;text-align:center;\">" + (Number(p.qty) || 0)
        + "</td><td style=\"padding:10px 12px;border-bottom:1px solid #eee;text-align:right;\">Rs. " + (((Number(p.price) || 0) * (Number(p.qty) || 0))).toFixed(2) + "</td></tr>";
    }).join("");

    var paid = String(order.paymentStatus || order.paymentMethod || "Pending").toLowerCase();
    var payNote = String(order.paymentMethod || "Cash on Delivery");
    var subject = "Your Lumina Skincare order " + orderId + " is confirmed";
    var htmlBody =
      "<div style=\"font-family:Jost,'Segoe UI',Helvetica,Arial,sans-serif;background:#F7F3EC;padding:28px;\">"
      + "<div style=\"max-width:560px;margin:0 auto;background:#FFFDF7;border-radius:16px;overflow:hidden;\">"
      + "<div style=\"background:#1E3A2F;color:#FFFDF7;padding:22px 28px;font-size:20px;font-weight:600;\">LUMINA<span style=\"color:#B8915A;\"> SKINCARE</span></div>"
      + "<div style=\"padding:28px;\">"
      + "<h2 style=\"margin:0 0 6px;color:#1E3A2F;\">Hello " + escapeHtml_(String(order.name || "")) + "!</h2>"
      + "<p style=\"color:#6B6B62;margin:0 0 18px;\">Thank you for your order. Your order <b>" + escapeHtml_(orderId) + "</b> has been received"
      + (paid === "success" ? " and paid successfully." : ". Payment method: " + escapeHtml_(payNote) + ".") + "</p>"
      + "<h3 style=\"color:#1E3A2F;margin:0 0 8px;font-size:14px;letter-spacing:1.5px;text-transform:uppercase;\">Items</h3>"
      + "<table style=\"width:100%;border-collapse:collapse;background:#fff;border-radius:10px;\">"
      + "<thead><tr><th style=\"padding:10px 12px;text-align:left;color:#6B6B62;font-size:11px;letter-spacing:1px;text-transform:uppercase;\">Product</th><th style=\"padding:10px 12px;text-align:center;color:#6B6B62;font-size:11px;letter-spacing:1px;text-transform:uppercase;\">Qty</th><th style=\"padding:10px 12px;text-align:right;color:#6B6B62;font-size:11px;letter-spacing:1px;text-transform:uppercase;\">Amount</th></tr></thead>"
      + "<tbody>" + items + "</tbody></table>"
      + "<div style=\"text-align:right;padding:14px 4px 4px;font-weight:600;color:#1E3A2F;font-size:15px;\">Total: Rs. " + (Number(order.total) || 0).toFixed(2) + "</div>"
      + "<h3 style=\"color:#1E3A2F;margin:18px 0 8px;font-size:14px;letter-spacing:1.5px;text-transform:uppercase;\">Delivery</h3>"
      + "<p style=\"color:#6B6B62;margin:0;\">" + escapeHtml_(String(order.address || "")) + "<br>" + escapeHtml_(String(order.city || "")) + " - " + escapeHtml_(String(order.pincode || "")) + "</p>"
      + "<p style=\"color:#8A9891;font-size:13px;margin-top:18px;border-top:1px solid #eee;padding-top:14px;\">You can track this order anytime on the Lumina Skincare store using Order ID <b>" + escapeHtml_(orderId) + "</b>.</p>"
      + "</div></div></div>";

    MailApp.sendEmail({
      to: email,
      subject: subject,
      htmlBody: htmlBody
    });

    setOrderField_(orderId, "Email Sent", formatTimestamp_(new Date()));
    console.log("[LUMINA][email] Order confirmation sent to " + email + " for " + orderId);
    return true;
  } catch (err) {
    console.log("[LUMINA][email] Failed to send order email for " + orderId + ": " + err);
    return false;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Writes a field to every row of an order (by exact header name). Returns false
// if the Orders sheet lacks the Order ID or the target column.
function setOrderField_(orderId, fieldName, value, sheet) {
  sheet = sheet || ensureSheet_("Orders", ORDERS_HEADERS);
  var width = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  var idCol = -1, fCol = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === "Order ID") idCol = i;
    else if (String(headers[i]).trim() === fieldName) fCol = i;
  }
  if (idCol === -1 || fCol === -1) return false;
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    for (var j = 0; j < rows.length; j++) {
      if (String(rows[j][idCol]).trim().toUpperCase() === orderId) {
        sheet.getRange(j + 2, fCol + 1).setValue(value);
      }
    }
  }
  return true;
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ------------------------------------------------------------
// PRODUCT REVIEWS & RATINGS
// ------------------------------------------------------------

// All reviews, newest first. Status is Pending / Approved / Rejected.
function readAllReviews_() {
  var sheet = ensureSheet_("Reviews", REVIEWS_HEADERS);
  var reviews = [];
  var last = sheet.getLastRow();
  if (last > 1) {
    var vals = sheet.getRange(2, 1, last - 1, REVIEWS_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      reviews.push({
        reviewId: String(vals[i][0]),
        productId: String(vals[i][1]),
        orderId: String(vals[i][2]),
        email: String(vals[i][3]),
        name: String(vals[i][4]),
        rating: Number(vals[i][5]) || 0,
        comment: String(vals[i][6]),
        date: String(vals[i][7]),
        status: String(vals[i][8])
      });
    }
  }
  reviews.reverse(); // newest first
  return reviews;
}

// Sanitizes a review comment: strips HTML, removes control characters,
// collapses whitespace and caps the length.
function sanitizeComment_(s) {
  var text = String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 1000) text = text.slice(0, 1000).trim();
  return text;
}

// Returns a delivered order (for this user) that contains the product, or null.
function findPurchasedDeliveredItem_(userId, email, productId) {
  if (!productId) return null;
  var orders = readAllOrders_();
  var em = String(email || "").toLowerCase().trim();
  var uid = String(userId || "");
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    var orderEmail = String(o.email || "").toLowerCase().trim();
    var owner = (em !== "" && orderEmail === em) || (uid !== "" && String(o.userId || "") === uid);
    if (!owner) continue;
    if (String(o.status || "").trim().toLowerCase() !== "delivered") continue;
    for (var j = 0; j < (o.products || []).length; j++) {
      if (String(o.products[j].productId || "") === String(productId)) {
        return { orderId: o.orderId, name: o.name };
      }
    }
  }
  return null;
}

// Looks up the display name from the Users sheet (used as the reviewer name).
function getUserNameByEmail_(email) {
  var em = String(email || "").toLowerCase().trim();
  if (!em) return "";
  var usersSheet = ensureSheet_("Users", USERS_HEADERS);
  migrateUsers_(usersSheet);
  var lastRow = usersSheet.getLastRow();
  if (lastRow > 1) {
    var vals = usersSheet.getRange(2, 3, lastRow - 1, 2).getValues(); // Name, Email
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][1]).toLowerCase().trim() === em) return String(vals[i][0]);
    }
  }
  return "";
}

// One review per (customer, product, order) to prevent duplicates.
function hasExistingReview_(email, productId, orderId) {
  var em = String(email || "").toLowerCase().trim();
  var reviews = readAllReviews_();
  for (var i = 0; i < reviews.length; i++) {
    if (String(reviews[i].email).toLowerCase().trim() === em
        && String(reviews[i].productId) === String(productId)
        && String(reviews[i].orderId) === String(orderId)) {
      return true;
    }
  }
  return false;
}

// PUBLIC — approved reviews for a product + average rating & count.
function doGetProductReviews_(e, method) {
  var data = getPayload_(e, method);
  var productId = clean_(data.productId);
  if (!productId) {
    return jsonResponse_({ success: false, error: "INVALID_INPUT", message: "Product ID is required." });
  }
  var approved = [];
  var reviews = readAllReviews_();
  for (var i = 0; i < reviews.length; i++) {
    if (String(reviews[i].productId) === String(productId)
        && String(reviews[i].status).toLowerCase() === "approved") {
      approved.push(reviews[i]);
    }
  }
  var sum = 0;
  for (var j = 0; j < approved.length; j++) sum += Number(approved[j].rating) || 0;
  var avg = approved.length > 0 ? Math.round((sum / approved.length) * 10) / 10 : 0;
  return jsonResponse_({
    success: true,
    reviews: approved,
    avgRating: avg,
    reviewCount: approved.length
  });
}

// PUBLIC (logged-in) — can this customer review this product?
function doGetReviewEligibility_(e, method) {
  var data = getPayload_(e, method);
  var userId = clean_(data.userId);
  var email = clean_(data.email).toLowerCase();
  var productId = clean_(data.productId);

  if (!userId && !isValidEmail_(email)) {
    return jsonResponse_({ success: false, eligible: false, message: "Please log in to review products." });
  }
  if (!productId) {
    return jsonResponse_({ success: false, eligible: false, error: "INVALID_INPUT", message: "Product ID is required." });
  }

  var purchased = findPurchasedDeliveredItem_(userId, email, productId);
  if (!purchased) {
    return jsonResponse_({ success: true, eligible: false, canReview: false, reason: "You can review this product once it has been delivered to you." });
  }
  if (hasExistingReview_(email, productId, purchased.orderId)) {
    return jsonResponse_({ success: true, eligible: false, canReview: false, reason: "You have already reviewed this product for this order." });
  }
  return jsonResponse_({ success: true, eligible: true, canReview: true, orderId: purchased.orderId });
}

// PUBLIC (logged-in) — submit a review. Saved as "Pending" until approved.
function doSubmitReview_(e, method) {
  var data = getPayload_(e, method);
  var userId = clean_(data.userId);
  var email = clean_(data.email).toLowerCase();
  var productId = clean_(data.productId);
  var ratingVal = Number(data.rating);
  var comment = sanitizeComment_(data.comment || "");

  if (!userId && !isValidEmail_(email)) {
    return jsonResponse_({ success: false, message: "Please log in to submit a review." });
  }
  if (!productId) return jsonResponse_({ success: false, message: "Product ID is required." });
  if (!(ratingVal >= 1 && ratingVal <= 5 && ratingVal === Math.floor(ratingVal))) {
    return jsonResponse_({ success: false, message: "Please select a rating between 1 and 5 stars." });
  }
  if (!comment) {
    return jsonResponse_({ success: false, message: "Please write a short review." });
  }

  var purchased = findPurchasedDeliveredItem_(userId, email, productId);
  if (!purchased) {
    return jsonResponse_({ success: false, message: "Only customers who have received this product can review it." });
  }
  if (hasExistingReview_(email, productId, purchased.orderId)) {
    return jsonResponse_({ success: false, message: "You have already reviewed this product for this order." });
  }

  var reviewId = "REV-" + generateId_();
  var reviewerName = getUserNameByEmail_(email) || purchased.name || clean_(data.name);
  ensureSheet_("Reviews", REVIEWS_HEADERS).appendRow([
    reviewId,
    productId,
    purchased.orderId,
    email,
    reviewerName,
    ratingVal,
    comment,
    formatTimestamp_(new Date()),
    "Pending"
  ]);

  return jsonResponse_({
    success: true,
    message: "Thank you! Your review will appear once it's approved.",
    reviewId: reviewId
  });
}

// ADMIN — all reviews (newest first).
function doGetReviews_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;
  return jsonResponse_({ success: true, reviews: readAllReviews_() });
}

// ADMIN — approve / reject / reopen a review.
function doUpdateReviewStatus_(e, method) {
  var auth = requireAdmin_(e, method);
  if (!auth.ok) return auth.res;

  var data = getPayload_(e, method);
  var reviewId = clean_(data.reviewId);
  var newStatus = clean_(data.status);

  if (!reviewId) return jsonResponse_({ success: false, message: "Review ID is required." });
  if (VALID_REVIEW_STATUSES.indexOf(newStatus) === -1) {
    return jsonResponse_({ success: false, message: "Invalid review status." });
  }

  var sheet = ensureSheet_("Reviews", REVIEWS_HEADERS);
  var width = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  var idCol = -1, statusCol = -1;
  for (var h = 0; h < headers.length; h++) {
    if (String(headers[h]).trim() === "ReviewID") idCol = h;
    else if (String(headers[h]).trim() === "Status") statusCol = h;
  }
  if (idCol === -1 || statusCol === -1) {
    return jsonResponse_({ success: false, message: "Reviews sheet is missing required columns." });
  }

  var lastRow = sheet.getLastRow();
  var found = false;
  if (lastRow > 1) {
    var rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][idCol]).trim() === reviewId) {
        found = true;
        sheet.getRange(i + 2, statusCol + 1).setValue(newStatus);
      }
    }
  }
  if (!found) return jsonResponse_({ success: false, message: "Review not found." });

  return jsonResponse_({
    success: true,
    message: "Review " + newStatus.toLowerCase() + ".",
    reviewId: reviewId,
    status: newStatus
  });
}

// PAGE — simple confirmation page for the hosted-payment fallback return URL.
function doPaymentReturn_(e) {
  var orderId = normalizeOrderId_((e && e.parameter && e.parameter.order_id) || "");
  var appUrl = ScriptApp.getService().getUrl();

  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<title>Payment Confirmation</title>';
  html += '<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f5f3ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#1e3a2f}.card{background:#fff;border-radius:14px;padding:32px;max-width:420px;width:90%;box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center}h1{font-size:21px;margin:0 0 8px}p{color:#556b63;line-height:1.5;margin:6px 0 0}.oid{background:#f0efe9;border-radius:8px;padding:10px;font-weight:600;margin:18px 0;word-break:break-all}.btn{display:inline-block;background:#1e3a2f;color:#fff;border:none;border-radius:8px;padding:12px 22px;font-size:15px;margin-top:18px;text-decoration:none;cursor:pointer}.muted{color:#8a9891;font-size:13px}</style></head><body>';
  html += '<div class="card"><div id="msg"><h1>Confirming your payment…</h1><p>Please wait a moment…</p></div></div>';
  html += '<script>';
  html += 'var orderId = ' + JSON.stringify(orderId) + ';';
  html += 'var appUrl = ' + JSON.stringify(appUrl) + ';';
  html += 'if (!orderId) { document.getElementById("msg").innerHTML = "<h1>Payment return</h1><p>No order reference was found.</p>"; } else {';
  html += 'fetch(appUrl + "?action=verifyPayment", { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ orderId: orderId }) })';
  html += '.then(function(r){ return r.text(); }).then(function(t){ var j; try { j = JSON.parse(t); } catch (e) { j = null; } return j; })';
  html += '.then(function(res){';
  html += '  var good = res && res.paymentStatus === "Success";';
  html += '  var failed = res && res.paymentStatus === "Failed";';
  html += '  var m = good ? "Payment successful. Thank you!" : (failed ? "The payment was not completed." : "Your payment is still being confirmed.");';
  html += '  var icon = good ? "&#10003;" : (failed ? "&#10007;" : "&#9889;");';
  html += '  var body = good ? "Your order " + orderId + " has been paid and will be shipped soon." : "Order reference: " + orderId;';
  html += '  var btn = "<button class=&quot;btn&quot; onclick=&quot;window.close();history.go(-1);&quot;>Go Back</button>";';
  html += '  document.getElementById("msg").innerHTML = "<h1>" + icon + " " + m + "</h1><p>" + body + "</p>" + btn;';
  html += '}).catch(function(){ document.getElementById("msg").innerHTML = "<h1>Payment return</h1><p>We could not confirm the payment right now. It will be confirmed by your store shortly.</p>"; });';
  html += '}';
  html += '</script></body></html>';

  return HtmlService.createHtmlOutput(html).setTitle("Payment Confirmation");
}

// ------------------------------------------------------------
// CONTACT
// ------------------------------------------------------------

function doContact_(e, method) {
  var data = getPayload_(e, method);

  var name    = clean_(data.name);
  var email   = clean_(data.email).toLowerCase();
  var subject = clean_(data.subject);
  var message = clean_(data.message);

  if (!name)  return jsonResponse_({ success: false, message: "Please enter your name." });
  if (!email || !isValidEmail_(email)) return jsonResponse_({ success: false, message: "Please enter a valid email." });
  if (!subject) return jsonResponse_({ success: false, message: "Please enter a subject." });
  if (!message) return jsonResponse_({ success: false, message: "Please enter a message." });

  var contactSheet = ensureSheet_("Contact Messages", [
    "Timestamp", "Name", "Email", "Subject", "Message", "Status"
  ]);

  contactSheet.appendRow([
    formatTimestamp_(new Date()),
    name,
    email,
    subject,
    message,
    "New"
  ]);

  return jsonResponse_({
    success: true,
    message: "Your message has been sent successfully"
  });
}

// ------------------------------------------------------------
// DEBUG — returns the target spreadsheet URL + row counts
// Use ?action=debug to confirm exactly WHERE the script writes.
// ------------------------------------------------------------

function doDebug_(e, method) {
  var ss = getSpreadsheet_();
  var info = {
    success: true,
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    spreadsheetId: ss.getId(),
    tabs: []
  };

  // Effective user email requires a separate scope; guard it so debug
  // still works without that permission.
  try {
    info.scriptOwnerEmail = Session.getEffectiveUser().getEmail();
  } catch (err) {
    info.scriptOwnerEmail = "(scope not authorized)";
  }

  var tabNames = ["Users", "Orders", "Contact Messages", "Reviews"];
  for (var i = 0; i < tabNames.length; i++) {
    var s = ss.getSheetByName(tabNames[i]);
    if (!s) continue;
    info.tabs.push({
      name: tabNames[i],
      rows: s.getLastRow() > 1 ? s.getLastRow() - 1 : 0
    });
  }

  return jsonResponse_(info);
}

// ------------------------------------------------------------
// SHEET MANAGEMENT
// ------------------------------------------------------------

function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = SPREADSHEET_ID && SPREADSHEET_ID.trim() !== ""
    ? SPREADSHEET_ID.trim()
    : props.getProperty("SPREADSHEET_ID");

  // 1) Try the pinned / saved ID first (most deterministic)
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (err) {
      // Pinned ID invalid/unavailable; fall through to name lookup
    }
  }

  // 2) Try to find by exact name in the (script owner's) Drive
  var files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  if (files.hasNext()) {
    var ss = SpreadsheetApp.open(files.next());
    props.setProperty("SPREADSHEET_ID", ss.getId());
    return ss;
  }

  // 3) Create a new spreadsheet and remember its ID
  var created = SpreadsheetApp.create(SPREADSHEET_NAME);
  props.setProperty("SPREADSHEET_ID", created.getId());
  return created;
}

function ensureSheet_(sheetName, headers) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  // Ensure headers exist and are bold
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");

  // Remove any stray "Sheet1" default sheet once real tabs exist
  var defaultSheet = ss.getSheetByName("Sheet1");
  if (defaultSheet) {
    var hasContent = ss.getLastRow() > 0 || ss.getSheets().length > 1;
    if (hasContent) {
      ss.deleteSheet(defaultSheet);
    }
  }

  return sheet;
}

// Migrates an older Users sheet that lacks the "Role" column.
function migrateUsers_(sheet) {
  if (!sheet) return;
  var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  if (headers.indexOf("Role") === -1) {
    var newCol = headers.length + 1;
    sheet.getRange(1, newCol).setValue("Role").setFontWeight("bold");
    var rows = sheet.getLastRow() - 1;
    if (rows > 0) {
      sheet.getRange(2, newCol, rows, 1).setValue("customer");
    }
  }
}

/**
 * OWNER HELPER — run once from the editor to grant admin access:
 *   setAdminRole("owner@example.com")
 * The account must already exist (created via the app's Sign Up).
 */
function setAdminRole(email) {
  var usersSheet = ensureSheet_("Users", USERS_HEADERS);
  migrateUsers_(usersSheet);
  var lastRow = usersSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("No users exist yet. Sign up first, then run setAdminRole again.");
    return;
  }
  var emails = usersSheet.getRange(2, 4, lastRow - 1, 1).getValues();
  for (var i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).toLowerCase().trim() === String(email).toLowerCase().trim()) {
      usersSheet.getRange(i + 2, 7).setValue("admin");
      Logger.log("Admin role granted to " + email);
      return;
    }
  }
  Logger.log("User not found: " + email);
}

// ------------------------------------------------------------
// PASSWORD HASHING (SHA-256)
// ------------------------------------------------------------

function hashPassword_(password) {
  // Salt is derived deterministically + timestamp-independent so login can
  // reproduce the same hash. Using HMAC-SHA256 with a fixed app salt.
  var salt = "lumina-skincare-salt-v1-9f4a";

  // Build the raw string to hash
  var raw = salt + "::" + password;

  var sig = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    raw,
    Utilities.Charset.UTF_8
  );

  // Convert signed byte array to positive hex
  return sig.map(function (byte) {
    var v = (byte < 0 ? byte + 256 : byte).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function getPayload_(e, method) {
  var data = {};
  if (method === "POST") {
    // Try to parse JSON body
    try {
      if (e && e.postData && e.postData.contents) {
        data = JSON.parse(e.postData.contents);
      }
    } catch (err) {
      data = {};
    }
  }
  // Support query (action/others via GET) params as fallback / merge
  if (e && e.parameter) {
    for (var key in e.parameter) {
      if (e.parameter.hasOwnProperty(key) && data[key] === undefined) {
        data[key] = e.parameter[key];
      }
    }
  }
  return data;
}

function clean_(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isValidEmail_(email) {
  var re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  return re.test(email);
}

function isValidPhone_(phone) {
  var re = /^[0-9+\-\s]{10,15}$/;
  return re.test(phone);
}

function isValidPincode_(pincode) {
  var re = /^\d{6}$/;
  return re.test(pincode);
}

function generateId_() {
  return Utilities.getUuid().replace(/-/g, "").slice(0, 12).toUpperCase();
}

function formatTimestamp_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// TEST / DEBUG (run manually from editor)
// ------------------------------------------------------------

function testSetup() {
  var usersSheet = ensureSheet_("Users", USERS_HEADERS);
  migrateUsers_(usersSheet);
  ensureSheet_("Orders", ORDERS_HEADERS);
  ensureSheet_("Contact Messages", CONTACT_HEADERS);
  ensureSheet_("Reviews", REVIEWS_HEADERS);
  Logger.log("Spreadsheet ready: " + getSpreadsheet_().getUrl());
}

/**
 * OWNER HELPER — create an admin account in one step:
 *   createAdminUser("Your Name", "owner@example.com", "yourpassword")
 */
function createAdminUser(name, email, password) {
  var res = { success: false };
  var e = {
    parameter: { action: "signup" },
    postData: { contents: JSON.stringify({
      name: name,
      email: email,
      password: password,
      confirmPassword: password
    }) }
  };
  var out = doSignup_(e, "POST");
  var payload = out.getContent();
  try { res = JSON.parse(payload); } catch (err) {}
  if (res && res.success) {
    setAdminRole(email);
    Logger.log("Admin account created for " + email);
  } else {
    Logger.log("Could not create admin: " + (res.message || payload));
  }
}
