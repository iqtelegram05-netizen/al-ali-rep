export interface Book {
  id?: string;
  title: string;
  author: string;
  sourceUrl: string;
  category: string;
  content?: string;
  createdAt: any;
}

export interface UserProgress {
  id?: string;
  userId: string;
  bookId: string;
  lastPage: number;
  savedTexts: string[];
}
