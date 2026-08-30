/**
 * A small site with real accounts, for the auth tests.
 *
 * Registering on someone else's site to prove a signup works is not a test -
 * it is rate-limited, unrepeatable, and leaves rubbish behind. This is the
 * same shape, locally: sessions in a cookie, a form that rejects duplicate
 * emails and mismatched confirmations, a dashboard that redirects when signed
 * out, and an optional Cloudflare-style interstitial in front of any route.
 *
 * The interstitial matters as much as the forms. A challenge served on the
 * *response to a submit* is the case that breaks naive automation: the form is
 * gone, nothing says "wrong password", and the flow has to notice.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type User = { email: string; password: string; name?: string };

export type AuthSiteOptions = {
  /** Accounts that exist before the test starts. */
  users?: User[];
  /**
   * Serve the login page in the shape a real site turned out to have:
   *
   * - `formless` - the submit button has no `type` and sits outside any
   *   `<form>`, as on practicetestautomation.com. Nothing to click by the
   *   usual selectors, and no form to submit.
   * - `delayed` - the fields are written by script a beat after load, as on
   *   OrangeHRM's React demo, so discovery at `domcontentloaded` finds an
   *   empty page.
   * - `hidden-logout` - the sign-out link exists but sits inside a closed
   *   menu, as on saucedemo. Visible-only detection misses it.
   */
  shape?: "plain" | "formless" | "delayed" | "hidden-logout";
  /**
   * Routes to put a challenge in front of, as `"GET /signup"`, each served
   * once. The solved widget then continues to where the request was going.
   */
  challenge?: string[];
};

export type AuthSite = {
  origin: string;
  users: () => User[];
  /** Requests the server has served, for asserting on what the flow did. */
  requests: () => string[];
  close: () => Promise<void>;
};

/** The widget, served to the page from the Cloudflare host by a route handler. */
export const WIDGET_HTML = `<!doctype html><body style="margin:0">
<div id="cb" style="position:absolute;left:20px;top:20px;width:26px;height:26px;border:1px solid #444"></div>
<script>
  let moves = 0;
  addEventListener("mousemove", () => moves++);
  document.getElementById("cb").addEventListener("click", () => parent.postMessage({ solved: true, moves }, "*"));
</script>`;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

/** As close to the real interstitial as the code under test can tell. */
const interstitial = (destination: string) =>
  page(
    "Just a moment...",
    `<h2>Performing security verification</h2>
     <div id="widget"></div>
     <script>
       window._cf_chl_opt = { cType: "managed", cRay: "fixture" };
       const root = document.getElementById("widget").attachShadow({ mode: "closed" });
       const frame = document.createElement("iframe");
       frame.src = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget";
       frame.style.cssText = "width:300px;height:65px;border:0";
       root.appendChild(frame);
       addEventListener("message", (event) => {
         if (event.data && event.data.solved) location.replace(${JSON.stringify(destination)});
       });
     </script>`
  );

const FIELDS = `<input id="email" type="email" name="email" autocomplete="email" required>
     <input id="password" type="password" name="password" autocomplete="current-password" required>`;

const loginForm = (error?: string, shape: AuthSiteOptions["shape"] = "plain") => {
  const alert = error ? `<div class="alert-danger">${error}</div>` : "";

  if (shape === "formless") {
    // No <form>, and a button with no type: neither `button[type=submit]` nor
    // `form button` matches, and pressing Enter submits nothing either - the
    // button's handler is the only way in.
    return page(
      "Sign in",
      `<h1>Sign in</h1>${alert}
       <div id="login">${FIELDS}<button id="submit" class="btn">Submit</button></div>
       <script>
         document.getElementById("submit").addEventListener("click", () => {
           const form = document.createElement("form");
           form.method = "POST"; form.action = "/login";
           for (const id of ["email", "password"]) {
             const input = document.createElement("input");
             input.name = id; input.value = document.getElementById(id).value;
             form.appendChild(input);
           }
           document.body.appendChild(form); form.submit();
         });
       </script>`
    );
  }

  if (shape === "delayed") {
    return page(
      "Sign in",
      `<h1>Sign in</h1>${alert}
       <div id="app"></div>
       <script>
         setTimeout(() => {
           document.getElementById("app").innerHTML =
             '<form method="POST" action="/login">${FIELDS.replace(/\n\s*/g, " ")}' +
             '<button type="submit">Log in</button></form>';
         }, 1500);
       </script>`
    );
  }

  return page(
    "Sign in",
    `<h1>Sign in</h1>${alert}
     <form method="POST" action="/login">${FIELDS}<button type="submit">Log in</button></form>`
  );
};

const signupForm = (error?: string) =>
  page(
    "Create an account",
    `<h1>Create an account</h1>
     ${error ? `<div class="alert-danger">${error}</div>` : ""}
     <form method="POST" action="/signup">
       <input id="name" type="text" name="name" autocomplete="name">
       <input id="email" type="email" name="email" autocomplete="email" required>
       <input id="password" type="password" name="password" autocomplete="new-password" required>
       <input id="password_confirmation" type="password" name="password_confirmation" required>
       <label><input type="checkbox" name="terms" id="terms"> I accept the terms</label>
       <button type="submit">Create account</button>
     </form>`
  );

const dashboard = (user: User, shape: AuthSiteOptions["shape"] = "plain") =>
  shape === "hidden-logout"
    ? page(
        "Shop",
        // Nothing a person can see says "signed in": the only marker is a
        // sign-out link inside a menu that is closed.
        `<h1>Products</h1><button id="menu">Open menu</button>
         <nav style="display:none"><a id="logout_link" href="/logout">Logout</a></nav>`
      )
    : page(
        "Dashboard",
        `<h1>Dashboard</h1><p>Welcome back, ${user.name ?? user.email}.</p>
         <a href="/logout">Sign out</a>`
      );

/**
 * Somewhere for a signed-in browser to do something.
 *
 * A counter that only moves when the button is really clicked, a list to read
 * several values from, a field to type into, and a link to somewhere else -
 * enough for an action list to be tested end to end without a real site.
 */
const app = () =>
  page(
    "App",
    `<h1>App</h1>
     <a href="/logout">Sign out</a>
     <p>Items in cart: <span id="count">0</span></p>
     <button id="add">Add to cart</button>
     <ul>
       <li class="item" data-sku="a1">First item <span class="price">$9.99</span></li>
       <li class="item" data-sku="b2">Second item <span class="price">$19.99</span></li>
       <li class="item" data-sku="c3">Third item <span class="price">$29.99</span></li>
     </ul>
     <input id="note" name="note" placeholder="a note">
     <p id="echo"></p>
     <a id="next" href="/app?page=2">next page</a>
     <div style="height:1400px"></div>
     <p id="bottom">the bottom</p>
     <script>
       const count = document.getElementById("count");
       document.getElementById("add").addEventListener("click", () => {
         count.textContent = String(Number(count.textContent) + 1);
       });
       document.getElementById("note").addEventListener("input", (e) => {
         document.getElementById("echo").textContent = e.target.value;
       });
     </script>`
  );

export async function startAuthSite(options: AuthSiteOptions = {}): Promise<AuthSite> {
  const users: User[] = [...(options.users ?? [])];
  const shape = options.shape ?? "plain";
  const sessions = new Map<string, string>();
  const requests: string[] = [];
  const pending = new Set(options.challenge ?? []);

  const read = (req: http.IncomingMessage) =>
    new Promise<URLSearchParams>((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(new URLSearchParams(body)));
    });

  const sessionUser = (req: http.IncomingMessage) => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const email = sid ? sessions.get(sid) : undefined;
    return users.find((u) => u.email === email);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    requests.push(route);

    const html = (body: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    const redirect = (to: string, headers: Record<string, string> = {}) => {
      res.writeHead(302, { location: to, ...headers });
      res.end();
    };

    // One challenge per configured route, in front of whatever it was doing.
    // A real one is issued by the edge before the origin sees the request;
    // this one is issued after, so a solved challenge can continue to the
    // destination the request was already heading for.
    const challenged = pending.has(route);

    if (route === "GET /" || route === "GET /login") {
      if (challenged) {
        pending.delete(route);
        return html(interstitial("/login"));
      }
      return html(loginForm(url.searchParams.get("error") ?? undefined, shape));
    }

    if (route === "POST /login") {
      const form = await read(req);
      const user = users.find(
        (u) => u.email === form.get("email") && u.password === form.get("password")
      );
      if (!user) return html(loginForm("These credentials do not match our records.", shape), 401);

      const sid = Math.random().toString(36).slice(2);
      sessions.set(sid, user.email);
      const cookie = { "set-cookie": `sid=${sid}; Path=/; HttpOnly` };
      if (challenged) {
        pending.delete(route);
        return html(interstitial("/dashboard"), 200, cookie);
      }
      return redirect("/dashboard", cookie);
    }

    if (route === "GET /signup") {
      if (challenged) {
        pending.delete(route);
        return html(interstitial("/signup"));
      }
      return html(signupForm());
    }

    if (route === "POST /signup") {
      const form = await read(req);
      const email = (form.get("email") ?? "").trim();
      const password = form.get("password") ?? "";

      if (!email || !password) return html(signupForm("Email and password are required."), 422);
      if (password !== form.get("password_confirmation")) {
        return html(signupForm("The password confirmation does not match."), 422);
      }
      if (users.some((u) => u.email === email)) {
        return html(signupForm("The email has already been taken."), 422);
      }

      const user: User = { email, password, name: form.get("name") ?? undefined };
      users.push(user);
      const sid = Math.random().toString(36).slice(2);
      sessions.set(sid, email);
      if (challenged) {
        pending.delete(route);
        return html(interstitial("/dashboard"), 200, { "set-cookie": `sid=${sid}; Path=/; HttpOnly` });
      }
      return redirect("/dashboard", { "set-cookie": `sid=${sid}; Path=/; HttpOnly` });
    }

    if (route === "GET /dashboard") {
      const user = sessionUser(req);
      // The redirect is the point: "signed in" has to mean a session the
      // server accepts, not a URL the browser happens to be on.
      return user ? html(dashboard(user, shape)) : redirect("/login?error=Please+sign+in");
    }

    if (url.pathname === "/app") {
      // Behind the session, like the rest of it: an action list that runs
      // without signing in first should find a login form, not an app.
      return sessionUser(req) ? html(app()) : redirect("/login?error=Please+sign+in");
    }

    if (url.pathname === "/logout") {
      return redirect("/login", { "set-cookie": "sid=; Path=/; Max-Age=0" });
    }

    html(page("Not found", "<h1>Not found</h1>"), 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    users: () => users,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
