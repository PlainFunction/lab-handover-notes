# How it works

What we built for Saltwater Photography: quotes that go quiet get a follow-up, in Kira's words, after Kira has said yes to it.

## What it does

When a quote has had no reply for four days, it writes a short follow-up in Kira's voice and sends it to her phone to approve. She can send it as it is, change it, or skip it. If the couple replies or books, it stops.

## What it doesn't do

It never sends anything Kira hasn't approved. It doesn't write quotes, change prices or touch the booking calendar.

## Where it runs

On a Cloudflare Worker in Plain Function's account, reading the Saltwater Gmail inbox through a Google connection Kira signed in to.

## When it checks

Once a day at 7am Sydney time. Approvals wait on her phone until she answers them, so a follow-up never goes out at midnight.

## What the follow-ups say

Each one is drafted from the original quote and three follow-ups Kira wrote by hand last summer. It mentions the date and the package, and never offers a discount.
