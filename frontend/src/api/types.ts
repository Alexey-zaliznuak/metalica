export type UserRole =
  | 'SKETCH_DESIGNER'
  | 'REVISION_DESIGNER'
  | 'MANAGER'
  | 'ADMIN'
  | string
export type UserScope =
  | 'ORDERS_CHANGE_RESPONSIBLE'
  | 'METRICS_VIEW'
  | 'WORKLOAD_VIEW'
  | string

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
  note?: string | null
  dialogLink?: string | null
  sketchDesignerId?: number | null
  revisionDesignerId?: number | null
}

export type OrderSource = 'MANUAL' | 'BLUESALES'

export interface BluesalesStatusOption {
  id: number
  name: string
}

export interface BluesalesTag {
  id: string
  name: string
  color: string | null
}

export interface OrderLead {
  id: number
  bsCustomerId: number | null
  name: string | null
  fullName: string | null
  vkDialogUrl: string | null
  vkUserId: string | null
  crmStatus: string | null
  tags: BluesalesTag[]
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

export interface OrderAssigneesResponse {
  managers: OrderAssignee[]
  sketchDesigners: OrderAssignee[]
  revisionDesigners: OrderAssignee[]
}

export interface OrderArticle {
  article: string | null
  name: string | null
  quantity: number | null
}

export interface Order {
  id: number
  orderNumber: string
  title: string | null
  note: string | null
  source: OrderSource
  dialogLink?: string | null
  orderStatusId: number | null
  orderStatus: string | null
  orderStatusSync: {
    state: 'pending' | 'retrying' | 'failed'
    attempts: number
    lastError: string | null
  } | null
  hasUrgentTag?: boolean
  crmStatusId?: number | null
  crmStatus?: string | null
  revisionCount: number
  openRevisions: number
  lastMessageAt: string | null
  createdAt: string
  deliveryManagerName?: string | null
  onboardingManagerName?: string | null
  sketchDesigner?: OrderAssignee | null
  revisionDesigner?: OrderAssignee | null
  lead?: OrderLead | null
  bluesalesInfo?: BluesalesOrderInfo | null
  articles?: OrderArticle[]
}

export interface OrderStatusSyncResponse {
  orderId: number
  orderStatusSync: Order['orderStatusSync']
}

export interface OrdersBoardSettings {
  selectedOrderStatusIds: number[]
  columnOrder: number[]
  searchQuery: string
  showNoOrderStatusColumn: boolean
  disableDesignerFilterForSketch: boolean
}

export interface OrdersColumnResponse {
  items: Order[]
  total: number
  page: number
  limit: number
  hasMore: boolean
}

export interface OrderFilterOptions {
  deliveryManagers: string[]
  onboardingManagers: string[]
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface MessagesPage<T> {
  items: T[]
  nextCursor: number | null
  hasMore: boolean
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

export interface OrderEvent {
  id: number
  orderId: number
  field: string
  oldValue: string | null
  newValue: string | null
  actor: MessageAuthor | null
  createdAt: string
}

export type ChatType = 'PUBLIC' | 'PRIVATE'
export type ChatMemberRole = 'MEMBER' | 'MODERATOR'

export interface ChatMemberUser {
  id: number
  username: string
  name: string
  role: UserRole
}

export interface ChatMember {
  userId: number
  role: ChatMemberRole
  joinedAt: string
  user: ChatMemberUser
}

export interface ChatListItem {
  id: number
  name: string
  type: ChatType
  createdById: number | null
  createdAt: string
  updatedAt: string
  members: ChatMember[]
  lastMessageAt: string | null
  lastMessage: {
    id: number
    body: string | null
    createdAt: string
    author: MessageAuthor
  } | null
}

export interface ChatMessage {
  id: number
  chatId: number
  body: string | null
  createdAt: string
  updatedAt: string
  author: MessageAuthor
  attachments: Attachment[]
}

export interface CreateChatPayload {
  name: string
  type?: ChatType
  memberIds?: number[]
}

export interface CreateChatMessagePayload {
  body?: string
  attachmentKeys?: string[]
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
  totalSketches: number
  openSketches: number
}

export interface DesignerMetric {
  designerId: number
  name: string
  revisions: number
  avgRevisionSeconds: number
}

export interface RevisionAnalyticsDesigner {
  designerId: number
  name: string
  count: number
  avgWorkingSeconds: number | null
}

export interface RevisionAnalytics {
  workStartHour: number
  workEndHour: number
  tzOffsetMinutes: number
  overall: {
    count: number
    avgWorkingSeconds: number | null
  }
  byDesigner: RevisionAnalyticsDesigner[]
}

export interface SketchAnalyticsDesigner {
  designerId: number
  name: string
  count: number
  avgWorkingSeconds: number | null
}

export interface SketchAnalytics {
  workStartHour: number
  workEndHour: number
  tzOffsetMinutes: number
  // Заказы, где эскиз начали готовить, но он ещё не готов.
  inProgressCount: number
  overall: {
    count: number
    avgWorkingSeconds: number | null
  }
  byDesigner: SketchAnalyticsDesigner[]
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
