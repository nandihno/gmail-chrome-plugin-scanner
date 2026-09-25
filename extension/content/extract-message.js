(() => {
  const subject = document.querySelector("h2.hP")?.textContent?.trim();
  if (!subject) {
    return { ok: false, reason: "Open an email in Gmail and try again." };
  }

  // In a conversation, capture the last expanded message visible in the DOM.
  const candidates = [...document.querySelectorAll(".adn.ads")]
    .map((root) => ({ root, body: root.querySelector(".a3s") }))
    .filter(({ body }) => body && body.getClientRects().length > 0);
  const selected = candidates.at(-1);
  if (!selected) {
    return { ok: false, reason: "No expanded message was found. Open a message and try again." };
  }

  const senderElement = selected.root.querySelector(".gD");
  const senderName = senderElement?.textContent?.trim() || "Unknown sender";
  const senderEmail = senderElement?.getAttribute("email")
    || senderElement?.getAttribute("data-hovercard-id")
    || "";
  const fullBody = selected.body.innerText || selected.body.textContent || "";
  const maxBodyLength = 30000;
  const maxLinks = 50;
  const links = [...selected.body.querySelectorAll("a[href]")]
    .filter((link) => /^https?:\/\//i.test(link.href))
    .map((link) => ({ text: (link.innerText || link.textContent || "").trim().slice(0, 250), href: link.href }));

  return {
    ok: true,
    message: {
      subject,
      sender: { name: senderName, email: senderEmail },
      body: fullBody.slice(0, maxBodyLength),
      bodyTruncated: fullBody.length > maxBodyLength,
      links: links.slice(0, maxLinks),
      linksTruncated: links.length > maxLinks
    }
  };
})();
