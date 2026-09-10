const CACHE_NAME = "qh-visionx-response-v1";

const STATIC_ASSETS = [
  "/frontend/",
  "/frontend/index.html",
  "/frontend/manifest.json"
];

/*
 * Install
 * ذخیره فایل‌های اصلی برای حالت آفلاین
 */
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});


/*
 * Activate
 * حذف Cache نسخه‌های قدیمی
 */
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});


/*
 * Fetch
 *
 * فایل‌های Frontend:
 * Cache First
 *
 * API:
 * Network First
 */
self.addEventListener("fetch", event => {

  const request = event.request;

  /*
   * فقط درخواست‌های GET
   */
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  /*
   * درخواست‌های API
   *
   * ابتدا اینترنت،
   * در صورت قطع بودن اینترنت
   * پاسخ Cache در صورت وجود
   */
  if (url.pathname.startsWith("/api/")) {

    event.respondWith(

      fetch(request)
        .then(response => {

          if (response.ok) {

            const responseClone =
              response.clone();

            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(
                  request,
                  responseClone
                );
              });

          }

          return response;

        })
        .catch(() => {

          return caches.match(request)
            .then(cachedResponse => {

              if (cachedResponse) {
                return cachedResponse;
              }

              return new Response(
                JSON.stringify({
                  offline: true,
                  message:
                    "اتصال اینترنت برقرار نیست."
                }),
                {
                  status: 503,
                  headers: {
                    "Content-Type":
                      "application/json; charset=utf-8"
                  }
                }
              );

            });

        })

    );

    return;
  }


  /*
   * فایل‌های Frontend
   *
   * ابتدا Cache
   */
  event.respondWith(

    caches.match(request)
      .then(cachedResponse => {

        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(request)
          .then(response => {

            if (
              response &&
              response.status === 200 &&
              response.type === "basic"
            ) {

              const responseClone =
                response.clone();

              caches.open(CACHE_NAME)
                .then(cache => {

                  cache.put(
                    request,
                    responseClone
                  );

                });

            }

            return response;

          });

      })

  );

});
