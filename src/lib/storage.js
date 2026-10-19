// 주문 이미지 업로드/삭제 + 클라이언트 사이드 리사이즈/WebP 압축 헬퍼.
// 버킷: order-images (public read, authenticated write).
// 경로 규칙: order-images/{orderId}/{timestamp}-{idx}.webp
import { supabase } from "./supabase.js";

const BUCKET = "order-images";
const MAX_WIDTH = 800;
const QUALITY = 0.75;

// 이미지 파일을 canvas로 리사이즈 + WebP로 압축해서 Blob 반환.
// 원본 가로가 MAX_WIDTH 이하면 리사이즈만 skip, 포맷 변환은 수행.
export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ratio = img.width > MAX_WIDTH ? MAX_WIDTH / img.width : 1;
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("compress failed"));
        },
        "image/webp",
        QUALITY
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}

// 이미지 1장 업로드 → public URL 반환.
export async function uploadOrderImage(file, orderId, idx = 0) {
  const blob = await compressImage(file);
  const path = `${orderId}/${Date.now()}-${idx}.webp`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: "image/webp",
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// 상품(품번) 사진 1장 업로드 → public URL 반환.
// 버킷: product-images (migrations/add_stock_rolls.sql). 경로 규칙: {productId}/{timestamp}.webp
const PRODUCT_BUCKET = "product-images";
export async function uploadProductImage(file, productId) {
  const blob = await compressImage(file);
  const path = `${productId}/${Date.now()}.webp`;
  const { error } = await supabase.storage.from(PRODUCT_BUCKET).upload(path, blob, {
    contentType: "image/webp",
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(PRODUCT_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// 품번을 지울 때 그 사진도 지운다(폴더 하위 일괄). 실패해도 품번 삭제는 막지 않는다 — 남아도 무해하다.
export async function deleteProductImages(productId) {
  try {
    const { data, error: listErr } = await supabase.storage.from(PRODUCT_BUCKET).list(`${productId}`);
    if (listErr) throw listErr;
    if (!data?.length) return;
    const { error } = await supabase.storage.from(PRODUCT_BUCKET).remove(data.map((f) => `${productId}/${f.name}`));
    if (error) throw error;
  } catch (e) {
    console.warn("[deleteProductImages]", productId, e.message);
  }
}

// 여러 장 병렬 업로드 (순서 유지).
export async function uploadOrderImages(files, orderId) {
  if (!files?.length) return [];
  return Promise.all(files.map((f, i) => uploadOrderImage(f, orderId, i)));
}

// 특정 주문의 모든 이미지 삭제 (폴더 하위 일괄).
export async function deleteOrderImages(orderId) {
  try {
    const { data, error: listErr } = await supabase.storage.from(BUCKET).list(`${orderId}`);
    if (listErr) throw listErr;
    if (!data?.length) return;
    const paths = data.map((f) => `${orderId}/${f.name}`);
    const { error } = await supabase.storage.from(BUCKET).remove(paths);
    if (error) throw error;
  } catch (e) {
    console.warn("[deleteOrderImages]", orderId, e.message);
  }
}
