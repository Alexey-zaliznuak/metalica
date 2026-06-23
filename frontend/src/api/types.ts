export type UserRole = 'DESIGNER' | 'MANAGER' | 'ADMIN' | string
export type UserScope = 'ORDERS_CHANGE_RESPONSIBLE' | string

export interface User {
  id: number
  name: string
  username: string
  role: UserRole
  scopes: UserScope[]
  frontendSettings?: Record<string, unknown> | null
}

export interface AdminUser {
  id: number
  username: string
  name: string
  role: UserRole
  scopes: UserScope[]
  createdAt: string
}

export interface CreateUserPayload {
  username: string
  name: string
  password: string
  role: UserRole
  scopes?: UserScope[]
}

export interface UpdateUserPayload {
  username?: string
  name?: string
  password?: string
  role?: UserRole
  scopes?: UserScope[]
}

export interface UpdateOrderPayload {
  orderNumber?: string
  title?: string
  deliveryManagerId?: number | null
  onboardingManagerId?: number | null
  sketchDesignerId?: number | null
  revisionDesignerId?: number | null
}

export type OrderSource = 'MANUAL' | 'BLUESALES'

export interface BluesalesStatusOption {
  id: number
  name: string
}

export interface OrderLead {
  id: number
  bsCustomerId: number | null
  name: string | null
  fullName: string | null
  vkDialogUrl: string | null
  vkUserId: string | null
  crmStatus: string | null
  lastSyncedAt: string | null
}

export interface BluesalesOrderInfo {
  bsOrderId: number
  bsNumber: string | null
  orderStatus: string | null
  orderStatusId: number | null
  crmStatus: string | null
  crmStatusId: number | null
  totalSum: number | null
  bsCreatedAt: string | null
  lastSyncedAt: string | null
}

export interface OrderAssignee {
  id: number
  name: string
  username: string
  role: UserRole
}

export interface Order {
  id: number
  orderNumber: string
  title: string | null
  source: OrderSource
  orderStatusId: number | null
  orderStatus: string | null
  crmStatusId?: number | null
  crmStatus?: string | null
  revisionCount: number
  openRevisions: number
  lastMessageAt: string | null
  createdAt: string
  deliveryManager?: OrderAssignee | null
  onboardingManager?: OrderAssignee | null
  sketchDesigner?: OrderAssignee | null
  revisionDesigner?: OrderAssignee | null
  lead?: OrderLead | null
  bluesalesInfo?: BluesalesOrderInfo | null
}

export interface OrdersBoardSettings {
  selectedOrderStatusIds: number[]
  columnOrder: number[]
  searchQuery: string
  showNoOrderStatusColumn: boolean
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export type MessageKind = 'NORMAL' | 'REVISION_REQUEST' | 'REVISION_ANSWER'

export interface Attachment {
  id: number
  url: string
  filename: string
  mimeType: string
  kind: string
}

export interface MessageAuthor {
  id: number
  name: string
  role: UserRole
}

export interface AnswerToRef {
  id: number
  createdAt: string
  body: string
}

export interface Message {
  id: number
  orderId: number
  kind: MessageKind
  body: string
  createdAt: string
  author: MessageAuthor
  answerToId: number | null
  answerTo?: AnswerToRef | null
  attachments: Attachment[]
}

export interface OrderMetrics {
  revisionCount: number
  avgRevisionSeconds: number
  openRevisions: number
}

export interface MetricsOverview {
  totalOrders: number
  totalRevisions: number
  avgRevisionSeconds: number
  openRevisions: number
  stuckRevisions: number
}

export interface DesignerMetric {
  designerId: number
  name: string
  revisions: number
  avgRevisionSeconds: number
}

export interface WorkloadMetric {
  userId: number
  name: string
  username: string
  role: UserRole
  deliveryOrders: number
  onboardingOrders: number
  sketchOrders: number
  revisionOrders: number
  revisionOrdersWithOpenRequest: number
}

export interface LoginResponse {
  accessToken: string
  user: User
}

export interface UploadResponse {
  key: string
  url: string
  filename: string
  mimeType: string
}

export interface CreateMessagePayload {
  body?: string
  kind: MessageKind
  answerToId?: number | null
  attachmentKeys?: string[]
}
