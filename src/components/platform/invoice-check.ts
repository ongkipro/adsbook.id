/** UX-8: "Cek status" on a pending subscription invoice asks AutoLaris Advice once, then reloads on a change. */
export function checkInvoiceButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-check-invoice]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.checkInvoice;
      if (!id || button.disabled) return;
      button.disabled = true;
      const label = button.textContent;
      button.textContent = "Memeriksa…";
      try {
        const response = await fetch(`/api/platform/invoices/${encodeURIComponent(id)}/check`, { method: "POST" });
        const payload = (await response.json().catch(() => ({}))) as { success?: boolean; message?: string; error?: string; data?: { outcome?: string } };
        button.textContent = payload.success ? payload.message ?? "Diperiksa" : payload.error ?? "Gagal memeriksa";
        if (payload.success && (payload.data?.outcome === "credited" || payload.data?.outcome === "already-paid")) {
          window.setTimeout(() => window.location.reload(), 900);
          return;
        }
      } catch {
        button.textContent = "Koneksi gagal";
      }
      window.setTimeout(() => {
        button.textContent = label;
        button.disabled = false;
      }, 2500);
    });
  }
}
