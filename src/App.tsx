import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, 
  BookOpen, 
  Plus, 
  History, 
  Bookmark, 
  Settings, 
  LogOut, 
  LogIn,
  Loader2,
  ChevronRight,
  Sparkles,
  X,
  Maximize2,
  FileText,
  BrainCircuit,
  MessageSquare
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, loginWithGoogle, logout, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  onSnapshot, 
  orderBy, 
  serverTimestamp,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  arrayUnion,
  deleteDoc
} from 'firebase/firestore';
import { Book, UserProgress } from './types';
import { cn } from './lib/utils';
import { GoogleGenAI } from "@google/genai";
import ReactMarkdown from 'react-markdown';

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('الكل');
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [showReader, setShowReader] = useState(false);
  const [aiResponse, setAiResponse] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [userProgress, setUserProgress] = useState<UserProgress | null>(null);
  const [savedTexts, setSavedTexts] = useState<string[]>([]);
  const [bookSearchQuery, setBookSearchQuery] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const [aiBubbleText, setAiBubbleText] = useState('');
  const [showAiBubble, setShowAiBubble] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'ai', text: string }[]>([]);
  const [pdfText, setPdfText] = useState('');
  const [isUploadingPdf, setIsUploadingPdf] = useState(false);
  const [teacherConfig, setTeacherConfig] = useState({ bookId: '', page: '' });
  const [selectedInfallible, setSelectedInfallible] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setMounted(true);
    setIsMobile(window.innerWidth < 768);
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    
    const q = query(collection(db, 'books'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const blacklist = [
        'test', 'temp', 'null', 'undefined', 'unknown', 'demo',
        'sample', 'example', 'placeholder', 'dummy', 'fake', 'mock',
        'todo', 'fixme', 'blank', 'empty', 'none',
        'بحث', 'خيارات', 'سجل', 'أرشيف'
      ];
      const booksData = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Book))
        .filter(b => {
          if (!b.title) return false;
          if (!b.sourceUrl) return false;
          if (b.title === 'عنوان غير معروف') return false;
          if (b.title.trim().length < 5) return false;
          if (/^[\d\W\s]+$/.test(b.title.trim())) return false;
          return !blacklist.some(word => b.title.toLowerCase().includes(word.toLowerCase()));
        });
      setBooks(booksData);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'books'));

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!user || !selectedBook) return;
    
    const progressId = `${user.uid}_${selectedBook.id}`;
    const unsubscribe = onSnapshot(doc(db, 'userProgress', progressId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as UserProgress;
        setUserProgress(data);
        setSavedTexts(data.savedTexts || []);
      } else {
        setUserProgress(null);
        setSavedTexts([]);
      }
    });

    return () => unsubscribe();
  }, [user, selectedBook]);

  const handleScrape = async () => {
    if (!scrapeUrl) return;
    setIsScraping(true);
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: scrapeUrl })
      });
      const data = await res.json();
      
      if (data.error) throw new Error(data.error);

      if (data.type === 'empty') {
        alert(data.message || 'لم يتم العثور على كتب PDF صالحة في هذا الرابط.');
        setScrapeUrl('');
        setIsScraping(false);
        return;
      }

      if (data.type === 'list') {
        const strictBlacklist = [
          'test', 'null', 'undefined', 'unknown', 'temp', 'demo',
          'sample', 'example', 'dummy', 'fake', 'mock',
          'بحث', 'خيارات', 'سجل', 'أرشيف'
        ];
        const validItems = data.items.filter((item: any) => {
          if (!item.title || !item.url) return false;
          if (item.title.trim().length < 5) return false;
          if (/^[\d\W\s]+$/.test(item.title.trim())) return false;
          return !strictBlacklist.some(w => item.title.toLowerCase().includes(w));
        });
        if (validItems.length === 0) {
          alert('لم يتم العثور على كتب حقيقية تطابق معايير الفلترة الصارمة.');
          setIsScraping(false);
          return;
        }
        for (const item of validItems) {
          await addDoc(collection(db, 'books'), {
            title: item.title,
            author: 'مؤلف غير معروف',
            sourceUrl: item.url,
            category: 'الكل',
            createdAt: serverTimestamp()
          });
        }
        alert(`تم جلب ${validItems.length} كتاب بنجاح!`);
      } else if (data.type === 'book') {
        if (!data.title || data.title === 'عنوان غير معروف' || data.title.trim().length < 5) {
          alert('الرابط لا يحتوي على كتاب حقيقي — العنوان مرفوض من المنخل.');
          setIsScraping(false);
          return;
        }
        await addDoc(collection(db, 'books'), {
          title: data.title,
          author: data.author,
          sourceUrl: data.sourceUrl,
          content: data.content,
          category: 'الكل',
          createdAt: serverTimestamp()
        });
        alert('تمت الفهرسة بنجاح!');
      }
      
      setScrapeUrl('');
    } catch (error) {
      console.error(error);
      alert('فشل في جلب البيانات');
    } finally {
      setIsScraping(false);
    }
  };

  const fetchBookContent = async (book: Book) => {
    if (book.content) return;
    try {
      const res = await fetch('/api/fetch-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: book.sourceUrl })
      });
      const data = await res.json();
      if (data.content) {
        if (book.id) {
          await updateDoc(doc(db, 'books', book.id), { content: data.content });
        }
        setSelectedBook({ ...book, content: data.content });
      }
    } catch (error) {
      console.error("Error fetching book content:", error);
    }
  };

  const handleAiAction = async (action: 'narrate' | 'explain' | 'mindmap' | 'dialect' | 'chat' | 'teacher' | 'pdf' | 'sira', text?: string) => {
    setIsAiLoading(true);
    if (action !== 'chat') setAiResponse('');
    
    const context = selectedBook?.content || books.map(b => b.content).join('\n').slice(0, 10000);
    const promptMap = {
      narrate: `حول النص التالي من الكتاب إلى رواية مشوقة: ${text || context}`,
      explain: `اشرح النص التالي بأسلوب مبسط وعميق: ${text || context}`,
      mindmap: `قم بتوليد خريطة ذهنية بصيغة Mermaid.js للنص التالي: ${text || context}`,
      dialect: `أجب على السؤال التالي باللهجة العراقية بناءً على محتوى المكتبة: ${searchQuery}`,
      chat: `أنت 'المفكر عبد الزهراء'، مساعد عقائدي وفلسفي رصين. أجب على السؤال التالي بناءً على محتوى المكتبة حصراً: ${text}`,
      teacher: `أنت 'الأستاذ الخاص'. قم بتحويل النص التالي من الصفحة ${teacherConfig.page} في الكتاب إلى درس تعليمي مبسط وشرح مفصل للطلبة: ${text || context}`,
      pdf: `قم بتحليل البحث التالي المرفوع بملف PDF، قارنه بالمصادر الموثوقة، أعطِ نصائح لتقويته ونسبة دقة علمية: ${pdfText}`,
      sira: `ولد ملخصاً ذكياً لسيرة وكلمات المعصوم (${selectedInfallible}) بناءً على كتب المكتبة فقط.`
    };

    try {
      const response = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: promptMap[action],
        config: {
          systemInstruction: action === 'chat' 
            ? "أنت 'المفكر عبد الزهراء'، مساعد عقائدي وفلسفي رصين. أجب على الأسئلة بناءً على محتوى المكتبة حصراً. استخدم لغة عربية فصحى عميقة وجذابة."
            : "أنت مساعد ذكي لمكتبة العلي الرقمية. يجب أن تكون إجاباتك مستمدة حصراً من محتوى الكتب المضافة. لا تستخدم معلومات من الإنترنت الخارجي. التزم باللغة العربية الفصحى الرصينة إلا إذا طُلب منك غير ذلك."
        }
      });
      const result = response.text || 'لا يوجد رد';
      
      if (action === 'chat') {
        setChatMessages(prev => [...prev, { role: 'ai', text: result }]);
      } else {
        setAiResponse(result);
      }

      if (action === 'dialect') {
        setAiBubbleText(result);
        setShowAiBubble(true);
        setTimeout(() => setShowAiBubble(false), 10000);
      }
    } catch (error) {
      console.error(error);
      if (action === 'chat') {
        setChatMessages(prev => [...prev, { role: 'ai', text: 'حدث خطأ في معالجة طلبك' }]);
      } else {
        setAiResponse('حدث خطأ في معالجة الطلب');
      }
    } finally {
      setIsAiLoading(false);
    }
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsUploadingPdf(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload-pdf', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPdfText(data.text);
      alert('تم رفع البحث بنجاح، جاري التحليل...');
      handleAiAction('pdf');
    } catch (error) {
      console.error(error);
      alert('فشل في رفع الملف');
    } finally {
      setIsUploadingPdf(false);
    }
  };

  const saveSnippet = async (text: string) => {
    if (!user || !selectedBook) return;
    const progressId = `${user.uid}_${selectedBook.id}`;
    try {
      await setDoc(doc(db, 'userProgress', progressId), {
        userId: user.uid,
        bookId: selectedBook.id,
        savedTexts: arrayUnion(text)
      }, { merge: true });
      alert('تم الحفظ في المحفوظات');
    } catch (error) {
      console.error(error);
    }
  };

  if (!user) {
    if (!mounted) return <div className="min-h-screen bg-white" />;
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-4 text-right overflow-hidden relative" dir="rtl">
        <div className="absolute inset-0 pointer-events-none opacity-[0.03]" 
             style={{ backgroundImage: 'linear-gradient(#00E676 1px, transparent 1px), linear-gradient(90deg, #00E676 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        <motion.div 
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative z-10 text-center space-y-12"
        >
          <div className="relative inline-block">
            <motion.div 
              animate={{ 
                scale: [1, 1.05, 1],
                rotate: [0, 5, -5, 0]
              }}
              transition={{ duration: 6, repeat: Infinity }}
              className="w-64 h-64 relative z-10 flex items-center justify-center"
            >
              <div className="absolute inset-0 bg-emerald-400 blur-[80px] opacity-20" />
              <img 
                src="https://www.image2url.com/r2/default/images/1776215661522-3ce7e2b6-4b67-46d7-898b-85a767165977.png" 
                alt="النواة"
                className="w-full h-full object-contain drop-shadow-[0_0_30px_rgba(0,230,118,0.3)]"
                referrerPolicy="no-referrer"
              />
            </motion.div>
          </div>

          <div className="space-y-4">
            <h1 className="text-7xl font-black text-gray-900 tracking-tighter">مكتبة العلي الرقمية</h1>
            <p className="text-emerald-600 font-black text-2xl uppercase tracking-[0.3em]">الآلة الرقمية الهندسية</p>
          </div>

          <button 
            onClick={loginWithGoogle}
            className="group relative px-16 py-6 bg-gray-900 text-white rounded-[32px] font-black text-2xl transition-all hover:scale-105 active:scale-95 overflow-hidden shadow-2xl shadow-emerald-100"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-emerald-600 to-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity" />
            <span className="relative flex items-center gap-4">
              <LogIn className="w-8 h-8" />
              الدخول عبر النواة
            </span>
          </button>
        </motion.div>
      </div>
    );
  }

  if (!mounted) return <div className="min-h-screen bg-white" />;

  return (
    <div className="min-h-screen bg-white text-gray-900 font-sans overflow-hidden relative" dir="rtl">
      <div className="absolute inset-0 pointer-events-none opacity-[0.03]" 
           style={{ backgroundImage: 'linear-gradient(#00E676 1px, transparent 1px), linear-gradient(90deg, #00E676 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-10">
        <div className="w-[1000px] h-[1000px] border border-emerald-500 rounded-full animate-rotate-slow" />
        <div className="absolute w-[700px] h-[700px] border border-emerald-500/50 rounded-full animate-rotate-slow [animation-direction:reverse]" />
      </div>

      <header className="absolute top-8 left-0 right-0 z-50 px-16 flex items-center justify-between">
        <div className="flex items-center gap-12">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-200">
              <BookOpen className="text-white w-6 h-6" />
            </div>
            <span className="font-black text-2xl text-emerald-900 tracking-tight">مكتبة العلي</span>
          </div>
          <nav className="flex items-center gap-10 text-sm font-bold text-gray-400">
            <button 
              className="hover:text-emerald-600 transition-colors tracking-widest uppercase"
              onClick={() => { setActiveCategory('المحفوظات الذكية'); setShowLibrary(true); }}
            >
              المحفوظات
            </button>
            <button 
              className="hover:text-emerald-600 transition-colors tracking-widest uppercase" 
              onClick={() => setIsScraping(true)}
            >
              الجالب
            </button>
            <button 
              className="hover:text-emerald-600 transition-colors tracking-widest uppercase"
              onClick={() => setActiveModal('chat')}
            >
              المفكر
            </button>
          </nav>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-4 px-5 py-2.5 bg-white border border-emerald-50 rounded-2xl shadow-sm">
            <span className="text-xs font-black text-emerald-800 uppercase tracking-tighter">الملف الشخصي</span>
            <img src={user.photoURL || ''} alt="" className="w-9 h-9 rounded-full border-2 border-emerald-500 p-0.5" />
          </div>
          <button onClick={logout} className="p-2.5 text-gray-300 hover:text-red-500 transition-colors">
            <LogOut className="w-6 h-6" />
          </button>
        </div>
      </header>

      <main className="relative w-full h-screen flex items-center justify-center overflow-hidden">
        <AnimatePresence mode="wait">
          {!showLibrary ? (
            <motion.div 
              key="machine"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.1 }}
              transition={{ duration: 0.5 }}
              className="relative w-full h-full flex flex-col md:flex-row items-center justify-center p-6"
            >
              <svg className="absolute inset-0 w-full h-full pointer-events-none z-10 hidden md:block">
                <defs>
                  <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00E676" stopOpacity="0" />
                    <stop offset="50%" stopColor="#00E676" stopOpacity="0.2" />
                    <stop offset="100%" stopColor="#00E676" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[
                  { angle: -30 }, { angle: 30 }, { angle: 90 }, 
                  { angle: 150 }, { angle: 210 }, { angle: 270 }
                ].map((item, i) => {
                  const x2 = 50 + Math.cos((item.angle * Math.PI) / 180) * 20;
                  const y2 = 50 + Math.sin((item.angle * Math.PI) / 180) * 20;
                  return (
                    <line 
                      key={i}
                      x1="50%" y1="50%" 
                      x2={`${x2}%`} y2={`${y2}%`} 
                      stroke="url(#lineGrad)" 
                      strokeWidth="1"
                    />
                  );
                })}
              </svg>

              <div className="relative z-20 flex flex-col md:flex-row items-center justify-center gap-12 md:gap-0">
                <motion.div 
                  animate={{ 
                    scale: [1, 1.02, 1],
                    rotate: [0, 360]
                  }}
                  transition={{ 
                    scale: { duration: 4, repeat: Infinity, ease: "easeInOut" },
                    rotate: { duration: 20, repeat: Infinity, ease: "linear" }
                  }}
                  className="relative"
                >
                  <div className="absolute inset-0 bg-emerald-400 blur-[100px] opacity-20 animate-pulse" />
                  <div className="w-48 h-48 md:w-80 md:h-80 relative z-10 flex items-center justify-center">
                    <img 
                      src="https://www.image2url.com/r2/default/images/1776215661522-3ce7e2b6-4b67-46d7-898b-85a767165977.png" 
                      alt="النواة المركزية"
                      className="w-full h-full object-contain drop-shadow-[0_0_40px_rgba(0,230,118,0.4)]"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                  
                  <AnimatePresence>
                    {showAiBubble && aiBubbleText && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0, y: 20 }}
                        className="absolute -top-32 left-1/2 -translate-x-1/2 w-64 bg-white/90 backdrop-blur-xl border border-emerald-100 p-4 rounded-3xl shadow-2xl z-50 text-right"
                      >
                        <div className="text-emerald-600 font-black text-[10px] mb-1 uppercase tracking-widest">المفكر الشيعي</div>
                        <div className="text-sm font-bold text-gray-800 leading-relaxed">{aiBubbleText}</div>
                        <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-white/90 rotate-45 border-r border-b border-emerald-100" />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>

                <div className={cn(
                  "flex gap-4 w-full md:w-auto",
                  isMobile ? "flex-col px-6" : "block"
                )}>
                  {[
                    { label: 'الكتب', angle: 0, id: 'books' },
                    { label: 'الأستاذ الخاص', angle: 72, id: 'teacher' },
                    { label: 'رفع بحث', angle: 144, id: 'pdf' },
                    { label: 'سيرة آل محمد', angle: 216, id: 'sira' },
                    { label: 'المفكر عبد الزهراء AI', angle: 288, id: 'chat' },
                  ].map((item, i) => (
                    <motion.button
                      key={i}
                      whileHover={{ scale: 1.1, backgroundColor: 'rgba(0, 230, 118, 0.2)' }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => {
                        if (item.id === 'books') {
                          setActiveCategory('الكل');
                          setShowLibrary(true);
                        } else {
                          setActiveModal(item.id);
                        }
                      }}
                      className={cn(
                        "z-30 glass-emerald px-6 py-4 shadow-2xl text-xs md:text-sm font-black text-emerald-900 transition-all",
                        isMobile ? "w-full rounded-2xl flex items-center justify-center" : "absolute w-40 h-20 flex items-center justify-center"
                      )}
                      style={!isMobile ? {
                        clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
                        left: '50%',
                        top: '50%',
                        marginLeft: '-80px',
                        marginTop: '-40px'
                      } : {}}
                      animate={{
                        x: isMobile ? 0 : Math.cos((item.angle * Math.PI) / 180) * 120,
                        y: isMobile ? 0 : Math.sin((item.angle * Math.PI) / 180) * 120,
                      }}
                    >
                      <span className="flex flex-col items-center gap-1 justify-center text-center">
                        <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse mb-1" />
                        {item.label}
                      </span>
                    </motion.button>
                  ))}
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="library"
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 50 }}
              className="absolute inset-0 z-40 bg-white/95 backdrop-blur-3xl p-24 pt-40 overflow-y-auto no-scrollbar"
            >
              <div className="max-w-7xl mx-auto">
                <div className="flex items-center justify-between mb-16">
                  <div>
                    <h2 className="text-5xl font-black text-gray-900 mb-4">مكتبة العلي الجبارة</h2>
                    <p className="text-emerald-600 font-black text-xl uppercase tracking-widest">{activeCategory}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={async () => {
                        if (confirm('هل أنت متأكد من مسح جميع الكتب نهائياً؟')) {
                          try {
                            for (const b of books) {
                              if (b.id) {
                                await deleteDoc(doc(db, 'books', b.id));
                              }
                            }
                            setBooks([]);
                            alert('تم تطهير المكتبة بنجاح!');
                          } catch (error) {
                            handleFirestoreError(error, OperationType.DELETE, 'books');
                          }
                        }
                      }}
                      className="px-6 py-3 bg-red-50 text-red-600 rounded-2xl font-black text-sm hover:bg-red-100 transition-all border border-red-100"
                    >
                      تطهير المكتبة
                    </button>
                    <button 
                      onClick={() => setShowLibrary(false)}
                      className="w-16 h-16 bg-gray-900 text-white rounded-full flex items-center justify-center hover:scale-110 transition-all shadow-2xl"
                    >
                      <X className="w-8 h-8" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10">
                  {books.filter(b => activeCategory === 'الكل' || b.category === activeCategory).length > 0 ? 
                    books.filter(b => activeCategory === 'الكل' || b.category === activeCategory).map((book) => (
                    <motion.div 
                      key={book.id}
                      whileHover={{ y: -10 }}
                      className="bg-white border border-emerald-100 rounded-[32px] p-8 shadow-xl hover:shadow-emerald-200/50 transition-all flex flex-col min-h-[350px] relative group"
                    >
                      <div className="absolute top-6 left-6 w-12 h-12 bg-emerald-50 rounded-2xl flex items-center justify-center group-hover:bg-emerald-600 group-hover:text-white transition-colors">
                        <BookOpen className="w-6 h-6" />
                      </div>
                      
                      <div className="mt-12 flex-1">
                        <h3 className="text-2xl font-black text-gray-900 mb-3 leading-tight line-clamp-2">{book.title}</h3>
                        <p className="text-emerald-600 font-bold text-lg mb-6">{book.author}</p>
                        <div className="inline-flex items-center px-4 py-1.5 bg-gray-50 rounded-full text-xs font-bold text-gray-500">
                          {book.category}
                        </div>
                      </div>

                      <div className="mt-auto pt-6">
                        <button 
                          onClick={() => {
                            setSelectedBook(book);
                            setShowReader(true);
                            if (!book.content) fetchBookContent(book);
                          }}
                          className="w-full bg-gray-900 text-white py-5 rounded-2xl font-black text-xl hover:bg-emerald-600 transition-all flex items-center justify-center gap-3 shadow-xl shadow-gray-200"
                        >
                          <BookOpen className="w-6 h-6" />
                          قراءة الكتاب
                        </button>
                      </div>
                    </motion.div>
                  )) : (
                    <div className="col-span-full py-32 text-center">
                      <BookOpen className="w-24 h-24 text-emerald-100 mx-auto mb-8" />
                      <h3 className="text-3xl font-black text-gray-300">لا توجد كتب في هذا القسم حالياً</h3>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div 
          initial={{ y: -50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="absolute top-24 right-4 md:right-16 z-40 w-[calc(100%-32px)] md:w-[400px]"
        >
          <div className="bg-white/80 backdrop-blur-xl border border-emerald-50 rounded-3xl p-2 flex items-center shadow-2xl shadow-emerald-100/20">
            <Search className="mr-4 text-emerald-500 w-6 h-6" />
            <input 
              type="text" 
              placeholder="اسأل باللهجة العراقية..." 
              className="flex-1 bg-transparent border-none py-4 px-3 text-lg outline-none text-right placeholder:text-gray-300 font-bold"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAiAction('dialect')}
            />
            <button 
              onClick={() => handleAiAction('dialect')}
              className="bg-emerald-600 text-white p-3.5 rounded-2xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-200"
            >
              <Sparkles className="w-6 h-6" />
            </button>
          </div>
        </motion.div>

        <motion.div 
          initial={{ x: -100, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          className="absolute right-16 top-1/2 -translate-y-1/2 z-20 w-80"
        >
          <div className="space-y-16">
            <div>
              <h3 className="text-2xl font-black text-gray-900 mb-2">استكمل رحلتك</h3>
              <p className="text-xs text-emerald-600 font-black uppercase tracking-[0.2em]">مسار الرحلة</p>
            </div>
            
            <div className="space-y-10 relative">
              {[
                { title: 'آخر الروايات', cat: 'الروايات الشريفة' },
                { title: 'المسارات', cat: 'المسارات الفلسفية' }
              ].map((item, i) => (
                <motion.div 
                  key={i}
                  className="relative group cursor-pointer"
                  whileHover={{ x: -10 }}
                  onClick={() => { setActiveCategory(item.cat); setShowLibrary(true); }}
                >
                  <div className="flex items-center gap-6">
                    <div className="w-14 h-14 bg-white border border-emerald-50 rounded-2xl flex items-center justify-center shadow-lg group-hover:shadow-emerald-100 transition-all">
                      <BookOpen className="text-emerald-500 w-6 h-6" />
                    </div>
                    <div>
                      <h4 className="font-black text-lg text-gray-800 group-hover:text-emerald-600 transition-colors">{item.title}</h4>
                      <div className="w-12 h-1 bg-emerald-100 rounded-full mt-2 group-hover:w-20 transition-all" />
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>

            <div className="pt-8 border-t border-emerald-50">
              <div className="flex justify-between text-[10px] font-black text-emerald-800 mb-4 uppercase tracking-widest">
                <span>التقدم</span>
                <span>85%</span>
              </div>
              <div className="h-2 bg-emerald-50 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: '85%' }}
                  className="h-full bg-emerald-500 shadow-[0_0_10px_#00E676]"
                />
              </div>
            </div>
          </div>
        </motion.div>

        <div className="absolute bottom-12 left-0 right-0 px-24 flex justify-between items-center text-[10px] font-black tracking-[0.5em] text-emerald-900/30 uppercase">
          <span>الآلة الرقمية الهندسية</span>
          <div className="flex items-center gap-4">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
            <span>النظام نشط</span>
          </div>
          <span>v2.0.0</span>
        </div>
      </main>

      <div className="fixed bottom-10 left-10 z-50">
        <motion.button 
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => setIsScraping(true)}
          className="w-16 h-16 bg-gray-900 text-white rounded-full flex items-center justify-center shadow-2xl neon-glow border border-emerald-500"
        >
          <Plus className="w-8 h-8" />
        </motion.button>
      </div>

      <AnimatePresence>
        {showReader && selectedBook && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 md:p-8"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white w-full h-full max-w-7xl rounded-3xl overflow-hidden flex flex-col md:flex-row shadow-2xl"
            >
              <div className="flex-1 flex flex-col bg-gray-50 relative">
                <div className="p-4 bg-white border-b flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <button onClick={() => setShowReader(false)} className="p-2 hover:bg-gray-100 rounded-full">
                      <X className="w-6 h-6" />
                    </button>
                    <h2 className="font-bold text-xl">{selectedBook.title}</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleAiAction('narrate')} className="flex items-center gap-2 px-4 py-2 bg-emerald-50 text-emerald-700 rounded-lg font-bold hover:bg-emerald-100 transition-all">
                      <Sparkles className="w-4 h-4" />
                      رواية
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto relative bg-[#FFFDF9] p-8 md:p-16 no-scrollbar">
                  {selectedBook.content ? (
                    <div className="max-w-3xl mx-auto prose prose-emerald prose-lg">
                      <div className="mb-12 pb-12 border-b border-emerald-100/50 text-center">
                        <h1 className="text-4xl font-black text-gray-900 mb-4">{selectedBook.title}</h1>
                        <p className="text-emerald-600 font-bold text-xl">{selectedBook.author}</p>
                      </div>
                      <div className="text-gray-800 leading-[2] text-xl font-medium text-justify whitespace-pre-wrap font-sans">
                        {selectedBook.content}
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center gap-6">
                      <Loader2 className="w-12 h-12 text-emerald-500 animate-spin" />
                      <p className="text-xl font-bold text-emerald-900">جاري جلب نص الكتاب من الخزينة...</p>
                      <button 
                        onClick={() => fetchBookContent(selectedBook)}
                        className="px-6 py-2 bg-emerald-600 text-white rounded-full font-bold"
                      >
                        إعادة المحاولة
                      </button>
                    </div>
                  )}
                  
                  <div className="fixed bottom-12 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur shadow-2xl rounded-3xl p-3 flex gap-4 border border-emerald-100 z-50">
                    <button onClick={() => handleAiAction('explain')} className="p-3 hover:bg-emerald-50 rounded-xl text-emerald-700 group relative">
                      <BrainCircuit className="w-6 h-6" />
                      <span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">اشرح</span>
                    </button>
                    <button onClick={() => handleAiAction('mindmap')} className="p-3 hover:bg-emerald-50 rounded-xl text-emerald-700 group relative">
                      <FileText className="w-6 h-6" />
                      <span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">خريطة ذهنية</span>
                    </button>
                    <button onClick={() => saveSnippet("نص محفوظ")} className="p-3 hover:bg-emerald-50 rounded-xl text-emerald-700 group relative">
                      <Bookmark className="w-6 h-6" />
                      <span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">حفظ</span>
                    </button>
                  </div>
                </div>
              </div>
              <div className="w-full md:w-96 border-r bg-white flex flex-col">
                <div className="p-6 border-b flex items-center gap-3">
                  <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center">
                    <Sparkles className="text-emerald-600 w-5 h-5" />
                  </div>
                  <h3 className="font-bold text-lg">مساعد العلي الذكي</h3>
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  {isAiLoading ? (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400 space-y-4">
                      <Loader2 className="w-10 h-10 animate-spin text-emerald-500" />
                      <p>جاري معالجة طلبك بذكاء...</p>
                    </div>
                  ) : aiResponse ? (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="prose prose-emerald max-w-none"
                    >
                      <ReactMarkdown>{aiResponse}</ReactMarkdown>
                    </motion.div>
                  ) : (
                    <div className="text-center text-gray-400 mt-20">
                      <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-20" />
                      <p>حدد نصاً أو اختر أحد الأوامر الذكية للبدء</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {activeModal === 'chat' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-md flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white w-full max-w-2xl h-[600px] rounded-[40px] shadow-2xl flex flex-col overflow-hidden border border-emerald-100"
            >
              <div className="p-8 border-b flex items-center justify-between bg-emerald-50/30">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg">
                    <BrainCircuit className="text-white w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-2xl font-black text-gray-900">المفكر عبد الزهراء AI</h3>
                    <p className="text-xs text-emerald-600 font-black uppercase tracking-widest">مساعد عقائدي وفلسفي</p>
                  </div>
                </div>
                <button onClick={() => setActiveModal(null)} className="p-3 hover:bg-white rounded-full transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-8 space-y-6 no-scrollbar">
                {chatMessages.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-30">
                    <MessageSquare className="w-16 h-16 text-emerald-600" />
                    <p className="text-xl font-bold">ابدأ الحوار العقائدي الآن</p>
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <motion.div 
                    key={i}
                    initial={{ opacity: 0, x: msg.role === 'user' ? -20 : 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={cn(
                      "flex flex-col max-w-[80%]",
                      msg.role === 'user' ? "mr-auto items-start" : "ml-auto items-end"
                    )}
                  >
                    <div className={cn(
                      "px-6 py-4 rounded-3xl text-lg font-bold",
                      msg.role === 'user' ? "bg-gray-100 text-gray-800 rounded-tr-none" : "bg-emerald-600 text-white rounded-tl-none shadow-lg shadow-emerald-100"
                    )}>
                      <ReactMarkdown>{msg.text}</ReactMarkdown>
                    </div>
                  </motion.div>
                ))}
                {isAiLoading && (
                  <div className="flex justify-end">
                    <div className="bg-emerald-50 px-6 py-4 rounded-3xl rounded-tl-none flex items-center gap-3">
                      <Loader2 className="w-5 h-5 animate-spin text-emerald-600" />
                      <span className="text-emerald-600 font-bold">جاري التفكير...</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="p-8 bg-gray-50/50 border-t">
                <div className="relative flex items-center">
                  <input 
                    type="text" 
                    placeholder="اطرح تساؤلك العقائدي..." 
                    className="w-full bg-white border border-emerald-100 rounded-2xl py-5 px-8 text-lg outline-none focus:ring-2 focus:ring-emerald-500 shadow-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.currentTarget.value) {
                        const text = e.currentTarget.value;
                        setChatMessages(prev => [...prev, { role: 'user', text }]);
                        handleAiAction('chat', text);
                        e.currentTarget.value = '';
                      }
                    }}
                  />
                  <div className="absolute left-4">
                    <Sparkles className="text-emerald-500 w-6 h-6 animate-pulse" />
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}

        {activeModal === 'teacher' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-md flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white w-full max-w-2xl rounded-[40px] shadow-2xl p-10 border border-emerald-100"
            >
              <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg">
                    <BrainCircuit className="text-white w-6 h-6" />
                  </div>
                  <h3 className="text-3xl font-black">الأستاذ الخاص</h3>
                </div>
                <button onClick={() => setActiveModal(null)} className="p-2 hover:bg-gray-100 rounded-full">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="space-y-8">
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <label className="text-xs font-black text-emerald-600 uppercase tracking-widest">اختر الكتاب</label>
                    <select 
                      className="w-full bg-gray-50 border border-emerald-50 rounded-2xl py-4 px-6 outline-none focus:ring-2 focus:ring-emerald-500"
                      value={teacherConfig.bookId}
                      onChange={(e) => setTeacherConfig(prev => ({ ...prev, bookId: e.target.value }))}
                    >
                      <option value="">اختر من المكتبة...</option>
                      {books.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
                    </select>
                  </div>
                  <div className="space-y-3">
                    <label className="text-xs font-black text-emerald-600 uppercase tracking-widest">رقم الصفحة</label>
                    <input 
                      type="number" 
                      placeholder="مثلاً: 45"
                      className="w-full bg-gray-50 border border-emerald-50 rounded-2xl py-4 px-6 outline-none focus:ring-2 focus:ring-emerald-500"
                      value={teacherConfig.page}
                      onChange={(e) => setTeacherConfig(prev => ({ ...prev, page: e.target.value }))}
                    />
                  </div>
                </div>

                <button 
                  onClick={() => {
                    const book = books.find(b => b.id === teacherConfig.bookId);
                    handleAiAction('teacher', book?.content);
                  }}
                  disabled={!teacherConfig.bookId || !teacherConfig.page || isAiLoading}
                  className="w-full bg-emerald-600 text-white py-5 rounded-2xl font-black text-xl hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-100 flex items-center justify-center gap-4"
                >
                  {isAiLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : <Sparkles className="w-6 h-6" />}
                  توليد الدرس التعليمي
                </button>

                {aiResponse && !isAiLoading && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-8 p-8 bg-emerald-50/30 rounded-3xl border border-emerald-100 overflow-y-auto max-h-[300px] no-scrollbar"
                  >
                    <div className="prose prose-emerald max-w-none">
                      <ReactMarkdown>{aiResponse}</ReactMarkdown>
                    </div>
                  </motion.div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}

        {activeModal === 'pdf' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-md flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white w-full max-w-2xl rounded-[40px] shadow-2xl p-10 border border-emerald-100"
            >
              <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg">
                    <FileText className="text-white w-6 h-6" />
                  </div>
                  <h3 className="text-3xl font-black">رفع بحث</h3>
                </div>
                <button onClick={() => setActiveModal(null)} className="p-2 hover:bg-gray-100 rounded-full">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="space-y-8">
                <div className="border-2 border-dashed border-emerald-200 rounded-[32px] p-12 text-center hover:bg-emerald-50/50 transition-all cursor-pointer relative group">
                  <input 
                    type="file" 
                    accept=".pdf" 
                    onChange={handlePdfUpload}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <div className="space-y-4">
                    <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto group-hover:scale-110 transition-transform">
                      <Plus className="text-emerald-600 w-10 h-10" />
                    </div>
                    <p className="text-xl font-bold text-gray-600">اضغط لرفع ملف PDF (حتى 15 صفحة)</p>
                    <p className="text-sm text-gray-400 font-bold">سيتم حذف الملف فوراً بعد التحليل</p>
                  </div>
                </div>

                {isUploadingPdf && (
                  <div className="flex items-center justify-center gap-4 text-emerald-600 font-black">
                    <Loader2 className="w-8 h-8 animate-spin" />
                    <span>جاري معالجة الملف...</span>
                  </div>
                )}

                {aiResponse && !isAiLoading && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-8 p-8 bg-emerald-50/30 rounded-3xl border border-emerald-100 overflow-y-auto max-h-[300px] no-scrollbar"
                  >
                    <div className="prose prose-emerald max-w-none">
                      <ReactMarkdown>{aiResponse}</ReactMarkdown>
                    </div>
                  </motion.div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}

        {activeModal === 'sira' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-md flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white w-full max-w-3xl rounded-[40px] shadow-2xl p-10 border border-emerald-100 flex flex-col h-[700px]"
            >
              <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg">
                    <History className="text-white w-6 h-6" />
                  </div>
                  <h3 className="text-3xl font-black">سيرة آل محمد</h3>
                </div>
                <button onClick={() => setActiveModal(null)} className="p-2 hover:bg-gray-100 rounded-full">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="grid grid-cols-3 md:grid-cols-5 gap-4 mb-10">
                {[
                  'النبي محمد ص', 'الإمام علي ع', 'السيدة فاطمة ع', 'الإمام الحسن ع', 'الإمام الحسين ع',
                  'الإمام السجاد ع', 'الإمام الباقر ع', 'الإمام الصادق ع', 'الإمام الكاظم ع', 'الإمام الرضا ع',
                  'الإمام الجواد ع', 'الإمام الهادي ع', 'الإمام العسكري ع', 'الإمام المهدي عج'
                ].map((name) => (
                  <button 
                    key={name}
                    onClick={() => {
                      setSelectedInfallible(name);
                      handleAiAction('sira');
                    }}
                    className={cn(
                      "px-4 py-3 rounded-2xl text-xs font-black transition-all border",
                      selectedInfallible === name 
                        ? "bg-emerald-600 text-white border-emerald-600 shadow-lg shadow-emerald-100" 
                        : "bg-gray-50 text-gray-600 border-gray-100 hover:border-emerald-200"
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto p-8 bg-emerald-50/20 rounded-3xl border border-emerald-50 no-scrollbar">
                {isAiLoading ? (
                  <div className="h-full flex flex-col items-center justify-center text-emerald-600 gap-4">
                    <Loader2 className="w-12 h-12 animate-spin" />
                    <p className="font-black">جاري استحضار السيرة الشريفة...</p>
                  </div>
                ) : aiResponse ? (
                  <div className="prose prose-emerald max-w-none">
                    <ReactMarkdown>{aiResponse}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-gray-300 gap-4">
                    <History className="w-20 h-20 opacity-20" />
                    <p className="text-xl font-bold">اختر اسماً من المعصومين (ع)</p>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isScraping && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-2xl font-black">بوابة الجلب الذكي</h3>
                <button onClick={() => setIsScraping(false)} className="p-2 hover:bg-gray-100 rounded-full">
                  <X className="w-6 h-6" />
                </button>
              </div>
              <div className="space-y-4">
                <div className="relative">
                  <input 
                    type="text" 
                    placeholder="ضع رابط الكتاب هنا..." 
                    className="w-full bg-gray-50 border border-gray-100 rounded-2xl py-4 px-6 focus:ring-2 focus:ring-emerald-500 outline-none"
                    value={scrapeUrl}
                    onChange={(e) => setScrapeUrl(e.target.value)}
                  />
                </div>
                <button 
                  onClick={handleScrape}
                  disabled={isScraping && scrapeUrl === ''}
                  className="w-full bg-emerald-600 text-white py-4 rounded-2xl font-black text-lg hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-100 flex items-center justify-center gap-3"
                >
                  {isScraping && scrapeUrl !== '' ? <Loader2 className="w-6 h-6 animate-spin" /> : <Plus className="w-6 h-6" />}
                  بدء الفهرسة الفورية
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
