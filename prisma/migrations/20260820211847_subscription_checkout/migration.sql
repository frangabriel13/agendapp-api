-- AlterTable
ALTER TABLE "subscription_payments" ADD COLUMN     "checkout_url" TEXT,
ADD COLUMN     "mp_preference_id" VARCHAR(100);
