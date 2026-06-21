import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { uploadsDir, ensureUploadsDir } from "./fileStore.js";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

function getUsersFilePath(): string {
  ensureUploadsDir();
  return path.join(uploadsDir, "_users.json");
}

function loadUsers(): User[] {
  const p = getUsersFilePath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as User[];
  } catch {
    return [];
  }
}

function saveUsers(users: User[]): void {
  fs.writeFileSync(getUsersFilePath(), JSON.stringify(users, null, 2));
}

export function findUserByUsername(username: string): User | null {
  const users = loadUsers();
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null;
}

export function findUserById(id: string): User | null {
  const users = loadUsers();
  return users.find((u) => u.id === id) ?? null;
}

export function createUser(username: string, passwordHash: string): User {
  const users = loadUsers();
  const id = createHash("sha256").update(`${username}${Date.now()}`).digest("hex").slice(0, 32);
  const user: User = {
    id,
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);
  return user;
}

export function usernameExists(username: string): boolean {
  return findUserByUsername(username) !== null;
}
